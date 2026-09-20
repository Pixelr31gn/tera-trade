/**
 * One-off analysis script (not part of the app) -- simulates a
 * "session-best-version switching agent" against real history, walk-forward
 * (no look-ahead: a signal's outcome is only considered "known" once
 * outcomeEvaluatedAt has actually passed, not just once outcomeLabel is
 * eventually filled in).
 *
 * Rule being simulated: for each session (new_york/london/asian)
 * independently, track cumulative taken+resolved samples per version
 * (v1/v2/v3/v5/v6/v7). Once at least one version has >=100 taken+resolved
 * samples for that session, select whichever has the highest taken-only win
 * rate. A signal is "kept" only if the selected version's OWN decision for
 * that exact signal was "taken". Before any version clears 100 samples for a
 * session, fall back to "keep the trade as it actually happened" (cold-start,
 * same posture as the existing session-best-version gate).
 *
 * Scope/limitation (reported, not hidden): this only re-evaluates the 225
 * real trades that already executed under the CURRENT consensus rule -- it
 * does not add new trades from signals that were skipped in reality but
 * would have been taken under this simpler rule. It answers "how would this
 * filter have changed the real trades we took," not the full population.
 */
import { prisma } from "../src/db/client.js";

const VERSIONS = ["v1", "v2", "v3", "v5", "v6", "v7"] as const;
type Version = (typeof VERSIONS)[number];
const SESSIONS = ["new_york", "london", "asian"] as const;
type Session = (typeof SESSIONS)[number];
const MIN_TAKEN_RESOLVED = 100;

const POSITIVE = new Set(["executed_win", "missed_win"]);

async function main() {
  console.log("Loading all score rows...");
  const scores = await prisma.score.findMany({
    where: { strategyVersion: { in: [...VERSIONS] } },
    select: {
      id: true, time: true, symbol: true, session: true, strategyVersion: true,
      decision: true, outcomeLabel: true, outcomeEvaluatedAt: true, tradeId: true, strategyId: true,
    },
    orderBy: { time: "asc" },
  });
  console.log(`Loaded ${scores.length} score rows.`);

  // Keyed by time+symbol+strategyId, NOT just time+symbol -- continuous-scan
  // evaluates both long and short candidates (continuous_v3_scan_long /
  // continuous_v3_scan_short) at the exact same instant, same symbol, so
  // time+symbol alone conflates two distinct signals into one group (caught
  // 2026-09-03 via trade #19: its representative row was
  // continuous_v3_scan_short/short/taken, but the same-instant
  // continuous_v3_scan_long/long rows were being matched instead for some
  // versions, corrupting the keep/filter decision).
  const bySignal = new Map<string, typeof scores>();
  for (const s of scores) {
    const key = `${s.time.toISOString()}|${s.symbol}|${s.strategyId}`;
    const list = bySignal.get(key) ?? [];
    list.push(s);
    bySignal.set(key, list);
  }

  console.log("Loading real closed trades...");
  const trades = await prisma.trade.findMany({
    where: { status: "closed" },
    select: { id: true, symbol: true, entryTime: true, pnl: true, side: true, quantity: true },
    orderBy: { entryTime: "asc" },
  });
  console.log(`Loaded ${trades.length} closed trades.`);

  const scoreByTradeId = new Map<number, (typeof scores)[number]>();
  for (const s of scores) {
    if (s.tradeId !== null) scoreByTradeId.set(s.tradeId, s);
  }

  const resolutionEvents = scores
    .filter((s) => s.outcomeLabel !== null && s.outcomeEvaluatedAt !== null)
    .sort((a, b) => a.outcomeEvaluatedAt!.getTime() - b.outcomeEvaluatedAt!.getTime());

  const index = new Map<string, { takenResolved: number; takenWins: number }>();
  function idxKey(session: string, version: string) {
    return `${session}|${version}`;
  }
  function getStats(session: string, version: string) {
    return index.get(idxKey(session, version)) ?? { takenResolved: 0, takenWins: 0 };
  }

  let resPtr = 0;
  function revealUpTo(cutoff: Date) {
    while (resPtr < resolutionEvents.length && resolutionEvents[resPtr]!.outcomeEvaluatedAt! < cutoff) {
      const row = resolutionEvents[resPtr]!;
      if (row.decision === "taken") {
        const key = idxKey(row.session, row.strategyVersion);
        const cur = index.get(key) ?? { takenResolved: 0, takenWins: 0 };
        cur.takenResolved++;
        if (row.outcomeLabel && POSITIVE.has(row.outcomeLabel)) cur.takenWins++;
        index.set(key, cur);
      }
      resPtr++;
    }
  }

  type Row = {
    tradeId: number; symbol: string; entryTime: Date; realPnl: number | null; session: string | null;
    selectedVersion: Version | "cold_start"; keptUnderAgent: boolean; simulatedPnl: number;
  };
  const rows: Row[] = [];

  let noSignalCount = 0;
  for (const trade of trades) {
    const repScore = scoreByTradeId.get(trade.id);
    if (!repScore) {
      noSignalCount++;
      rows.push({
        tradeId: trade.id, symbol: trade.symbol, entryTime: trade.entryTime,
        realPnl: trade.pnl !== null ? Number(trade.pnl) : null, session: null,
        selectedVersion: "cold_start", keptUnderAgent: true,
        simulatedPnl: trade.pnl !== null ? Number(trade.pnl) : 0,
      });
      continue;
    }

    revealUpTo(repScore.time);

    const session = repScore.session as Session;
    const candidates = VERSIONS.map((v) => ({ version: v, stats: getStats(session, v) })).filter((c) => c.stats.takenResolved >= MIN_TAKEN_RESOLVED);

    let selectedVersion: Version | "cold_start";
    let keptUnderAgent: boolean;

    // Margin refinement (2026-09-03, after the unrefined greedy rule
    // backtested net negative, concentrated in New York -- v1 was the lone
    // eligible candidate for a long stretch and turned out to have the
    // WORST taken-win-rate of NY's eventually-eligible versions, 15.8% vs
    // v7's 28.8%). Two requirements before overriding the fallback:
    // (a) at least 2 eligible candidates -- a lone candidate has nothing to
    //     be compared against and is exactly the failure mode observed;
    // (b) the leader's (winRate - 1 SE) must exceed the runner-up's
    //     (winRate + 1 SE) -- non-overlapping ~68% bands, i.e. don't switch
    //     on a gap that's within noise for this sample size.
    function stdErr(wins: number, n: number): number {
      const p = wins / n;
      return Math.sqrt((p * (1 - p)) / n);
    }

    if (candidates.length < 2) {
      selectedVersion = "cold_start";
      keptUnderAgent = true;
    } else {
      const withRates = candidates.map((c) => ({
        ...c,
        winRate: c.stats.takenWins / c.stats.takenResolved,
        se: stdErr(c.stats.takenWins, c.stats.takenResolved),
      }));
      withRates.sort((a, b) => b.winRate - a.winRate);
      const leader = withRates[0]!;
      const runnerUp = withRates[1]!;
      const marginClears = leader.winRate - leader.se > runnerUp.winRate + runnerUp.se;

      if (!marginClears) {
        selectedVersion = "cold_start";
        keptUnderAgent = true;
      } else {
        selectedVersion = leader.version;
        const signalKey = `${repScore.time.toISOString()}|${repScore.symbol}|${repScore.strategyId}`;
        const signalRows = bySignal.get(signalKey) ?? [];
        const versionRow = signalRows.find((r) => r.strategyVersion === selectedVersion);
        keptUnderAgent = versionRow?.decision === "taken";
      }
    }

    const realPnl = trade.pnl !== null ? Number(trade.pnl) : null;
    rows.push({
      tradeId: trade.id, symbol: trade.symbol, entryTime: trade.entryTime, realPnl, session,
      selectedVersion, keptUnderAgent,
      simulatedPnl: keptUnderAgent ? (realPnl ?? 0) : 0,
    });
  }

  const totalReal = rows.reduce((s, r) => s + (r.realPnl ?? 0), 0);
  const totalSimulated = rows.reduce((s, r) => s + r.simulatedPnl, 0);
  const kept = rows.filter((r) => r.keptUnderAgent);
  const filtered = rows.filter((r) => !r.keptUnderAgent);
  const coldStartCount = rows.filter((r) => r.selectedVersion === "cold_start").length;

  console.log("\n===== SUMMARY =====");
  console.log(`Trades total: ${rows.length} (no linked signal data: ${noSignalCount})`);
  console.log(`Cold-start (no version had ${MIN_TAKEN_RESOLVED}+ taken+resolved samples yet for that session): ${coldStartCount}`);
  console.log(`Kept under agent: ${kept.length}, Filtered out: ${filtered.length}`);
  console.log(`Actual real total PnL:     $${totalReal.toFixed(2)}`);
  console.log(`Simulated agent total PnL: $${totalSimulated.toFixed(2)}`);
  console.log(`Difference: $${(totalSimulated - totalReal).toFixed(2)}`);

  const filteredPnl = filtered.reduce((s, r) => s + (r.realPnl ?? 0), 0);
  const filteredWins = filtered.filter((r) => (r.realPnl ?? 0) > 0).length;
  const filteredLosses = filtered.filter((r) => (r.realPnl ?? 0) < 0).length;
  const keptPnl = kept.reduce((s, r) => s + (r.realPnl ?? 0), 0);
  const keptWins = kept.filter((r) => (r.realPnl ?? 0) > 0).length;
  const keptLosses = kept.filter((r) => (r.realPnl ?? 0) < 0).length;
  console.log(`\nFiltered-out trades: ${filteredWins}W / ${filteredLosses}L, sum pnl $${filteredPnl.toFixed(2)} (this is money the agent WOULD have left on the table)`);
  console.log(`Kept trades:          ${keptWins}W / ${keptLosses}L, sum pnl $${keptPnl.toFixed(2)} (this is the agent's simulated total)`);

  const nonColdKept = kept.filter((r) => r.selectedVersion !== "cold_start").length;
  const coldKept = kept.filter((r) => r.selectedVersion === "cold_start").length;
  console.log(`Kept breakdown: ${coldKept} kept via cold-start fallback (no version had ${MIN_TAKEN_RESOLVED}+ samples yet), ${nonColdKept} kept because the selected version's OWN decision agreed`);

  console.log("\n===== BY SESSION =====");
  for (const session of SESSIONS) {
    const sRows = rows.filter((r) => r.session === session);
    const sReal = sRows.reduce((s, r) => s + (r.realPnl ?? 0), 0);
    const sSim = sRows.reduce((s, r) => s + r.simulatedPnl, 0);
    console.log(`${session}: n=${sRows.length} realPnl=$${sReal.toFixed(2)} simPnl=$${sSim.toFixed(2)} diff=$${(sSim - sReal).toFixed(2)}`);
  }

  console.log("\n===== FILTERED-OUT TRADES (would NOT have been taken under the agent) =====");
  for (const r of filtered) {
    console.log(`#${r.tradeId} ${r.symbol} ${r.entryTime.toISOString()} session=${r.session} selected=${r.selectedVersion} realPnl=${r.realPnl}`);
  }

  console.log("\n===== VERSION SELECTION TIMELINE (first time each session leaves cold-start) =====");
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.selectedVersion === "cold_start" || !r.session) continue;
    const key = r.session;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`${r.session}: first non-cold-start pick = ${r.selectedVersion} at trade #${r.tradeId} (${r.entryTime.toISOString()})`);
    }
  }

  console.log("\n===== FINAL SELECTED VERSION PER SESSION (end of dataset) =====");
  for (const session of SESSIONS) {
    const stats = VERSIONS.map((v) => ({ v, s: getStats(session, v) })).filter((x) => x.s.takenResolved > 0);
    stats.sort((a, b) => b.s.takenResolved - a.s.takenResolved);
    console.log(`-- ${session} --`);
    for (const { v, s } of stats) {
      const wr = s.takenResolved > 0 ? ((s.takenWins / s.takenResolved) * 100).toFixed(1) : "n/a";
      const eligible = s.takenResolved >= MIN_TAKEN_RESOLVED ? "ELIGIBLE" : "below floor";
      console.log(`  ${v}: takenResolved=${s.takenResolved} winRate=${wr}% [${eligible}]`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
