/**
 * Phase 1 "definition of done" (see .claude/rules/replay-harness.md):
 * "replay a window that was traded live, and assert its decisions match the
 * stored Score rows for the same bars. Any mismatch is a harness bug, not a
 * market finding." This is that test.
 *
 * Requires a reachable Postgres (TEST_DATABASE_URL or DATABASE_URL) with the
 * schema already migrated -- skips cleanly if neither is set, since this
 * sandbox may not have a database available.
 *
 * DESIGN NOTE -- why synthetic bars instead of a real historical window:
 * risk/engine.ts's MAX_ENTRY_DISTANCE_ATR has changed seven times in nine
 * days per that file's own comment history, and scoring's minScoreThreshold
 * is a live core/config.ts setting, not a versioned/historical fact. An
 * equivalence check against a real OLD live-traded window would fail the
 * moment any such constant has changed since -- correctly, but for the wrong
 * reason ("the rule changed") instead of the one this test exists to catch
 * ("the harness computed something different from live given the SAME
 * rules"). A deterministic synthetic fixture run through TODAY's code on
 * BOTH paths back-to-back removes that confound entirely. Same reasoning
 * tests/engineIntegration.test.ts already uses.
 *
 * SCOPE NOTE -- why this only compares decisions up through the first trade
 * entry, not a full multi-trade window: live's SimulatedBroker fills a new
 * position immediately, at the deciding bar's own close (see
 * execution/engine.ts's executeIfApproved -> referencePrice: entryPrice,
 * which is closePrice). harness.ts's replay fills at the NEXT bar's open
 * instead, deliberately ("live cannot act on a close it has not seen yet").
 * Neither is wrong on its own terms, but it means the two paths' account
 * equity, and therefore every LATER bar's circuit-breaker-gated decision,
 * will legitimately diverge after the first trade closes -- not a harness
 * bug, but an unresolved modeling difference between how paper trading
 * actually fills and how replay models it. Comparing past the first entry
 * needs that resolved first (either make replay fill at this-bar's-close to
 * match live, or make live's paper fills wait for the next bar -- a real
 * product decision, not this test's call to make).
 */
import { Decimal } from "decimal.js";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTrendingBars } from "./fixtures.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hasRealDb = !!TEST_DB_URL && !TEST_DB_URL.includes("test:test@localhost");

// Real instrument symbol, not a synthetic one -- decideOnBar's getInstrument
// call has no fallback for an unrecognized symbol (unlike
// getFixedTargetEdge/getOpeningRangeStats, which catch and degrade
// gracefully), so a made-up symbol throws the moment any strategy actually
// fires a signal.
//
// "CL", not "ES" -- confirmed live (2026-08-02) that a synthetic bar-time
// window alone stopped being enough isolation once real historical "ES" data
// existed in the DB (backfilled for actual backtesting use): the LIVE path's
// loadRecentBars(symbol, 300) has no time upper bound, so once ~120 synthetic
// future-dated bars exist for "ES" it pads the remainder of its 300-bar
// window with real trailing 2026 "ES" data to fill the limit, while the
// REPLAY path's ReplayDecisionContext reads only the synthetic bars handed
// to its constructor -- a real divergence between the two paths' indicator
// inputs, not a harness bug. The symbol used here needs to be registered
// (getInstrument-safe) but excluded from ACTIVE_INSTRUMENTS
// (marketData/instruments.ts), so nothing ever backfills or live-feeds it --
// permanently collision-free regardless of what real data the active symbols
// accumulate.
//
// CHANGED FROM "GC" to "CL" (2026-09-08): GC was the original choice here for
// exactly the reason above, but was itself promoted to ACTIVE_INSTRUMENTS on
// 2026-09-03 (operator request, traded as MGC) -- silently invalidating this
// test's isolation from that point on. Surfaced as a hard failure the same
// day risk/engine.ts's requiresDailyPlan gate shipped (operator request: "i
// dont want any trades taken for gc unless it has a daily trading plan") --
// replay's own DailyPlanZone posture is always empty zones (see
// ReplayDecisionContext's own comment), so a REQUIRE_DAILY_PLAN_SYMBOLS
// member can now never complete a trade in replay at all, timing out this
// test instead of reaching "the first trade entry" it's actually testing
// for. Nothing about that gate is specific to this test's actual purpose
// (live/replay scoring equivalence) -- CL is registered but still excluded
// from ACTIVE_INSTRUMENTS, so it's the same kind of safe choice GC used to
// be. If CL is ever promoted to active trading too, pick another excluded
// symbol here rather than assuming this comment is still accurate.
const SYMBOL = "CL";
// 13:00 UTC = the start of the New York session (analytics/session.ts's
// classifySession) -- 2026-08-13, this test's 200 one-minute bars used to
// start at midnight (Asian session) and started failing the moment
// engine/loop.ts's determineConsensus gained an Asian-only v6-v7
// restriction (operator request), since this fixture's downtrend reliably
// triggers via a non-v6/v7 consensus path (see the comment below) that's
// now correctly blocked during Asian. That restriction has its own
// dedicated coverage in tests/paperConsensus.test.ts -- this test's actual
// purpose is live/replay bar-by-bar equivalence, unrelated to which session
// is active, so it's shifted into New York hours to stay unaffected by it
// (London would also have worked, since only Asian is restricted).
const SYNTHETIC_START = new Date("2099-01-01T13:00:00Z");
const MIN_BARS_FOR_REGIME = 120; // keep in sync with engine/loop.ts and replay/decisionCore.ts

function shiftToSyntheticWindow(bars: OhlcBar[]): OhlcBar[] {
  const originalStart = bars[0]!.time.getTime();
  return bars.map((b) => ({ ...b, time: new Date(SYNTHETIC_START.getTime() + (b.time.getTime() - originalStart)) }));
}

describe.skipIf(!hasRealDb)("replay equivalence (Phase 1 definition of done)", () => {
  let prisma: (typeof import("../src/db/client.js"))["prisma"];
  let TradingEngine: (typeof import("../src/engine/loop.js"))["TradingEngine"];
  let SimulatedBroker: (typeof import("../src/brokers/simulatedBroker.js"))["SimulatedBroker"];
  let ensureDefaultAccount: (typeof import("../src/engine/bootstrap.js"))["ensureDefaultAccount"];
  let decideOnBar: (typeof import("../src/replay/decisionCore.js"))["decideOnBar"];
  let ReplayDecisionContext: (typeof import("../src/replay/replayDecisionContext.js"))["ReplayDecisionContext"];
  let getSystemState: (typeof import("../src/execution/mode.js"))["getSystemState"];
  let setMode: (typeof import("../src/execution/mode.js"))["setMode"];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    ({ prisma } = await import("../src/db/client.js"));
    ({ TradingEngine } = await import("../src/engine/loop.js"));
    ({ SimulatedBroker } = await import("../src/brokers/simulatedBroker.js"));
    ({ ensureDefaultAccount } = await import("../src/engine/bootstrap.js"));
    ({ decideOnBar } = await import("../src/replay/decisionCore.js"));
    ({ ReplayDecisionContext } = await import("../src/replay/replayDecisionContext.js"));
    ({ getSystemState, setMode } = await import("../src/execution/mode.js"));
  });

  it("scores every bar identically whether decided live (onNewBar) or via decideOnBar in replay, through the first trade entry", async () => {
    // A steep DOWNtrend, not the default uptrend -- confirmed live (2026-08-01)
    // that makeTrendingBars(160)'s default uptrend never once reaches mutual
    // agreement under the current gate: v5's own pattern-mined thesis (see
    // ruleScorerV5.ts / BUILD_HISTORY.md) is that a strong trend favors
    // SHORTS, not longs, so v5 tops out around 30% on a long trend-following
    // signal no matter how clean the uptrend is, and never clears its
    // required 75% (see engine/loop.ts's V5_EXECUTION_GATE_THRESHOLD). A
    // strong downtrend reliably clears mutual agreement instead -- confirmed
    // deterministic at this exact seed/drift, firing at the first eligible
    // bar with ~80 bars of unused margin afterward.
    const allBars = shiftToSyntheticWindow(makeTrendingBars(200, 100, -0.6, 0.3, 42));
    const account = await ensureDefaultAccount();
    const engine = new TradingEngine(new SimulatedBroker(), null, null);

    // Self-healing: see tests/engineIntegration.test.ts's identical comment --
    // a prior run interrupted before reaching its own `finally` cleanup below
    // (confirmed happens under full-suite DB contention, see
    // vitest.config.ts's testTimeout comment) leaves synthetic rows behind
    // that would otherwise collide with this run's own inserts.
    await prisma.orderRecord.deleteMany({ where: { symbol: SYMBOL, trade: { entryTime: { gte: SYNTHETIC_START } } } });
    await prisma.trade.deleteMany({ where: { symbol: SYMBOL, entryTime: { gte: SYNTHETIC_START } } });
    await prisma.score.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });
    await prisma.bar.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });

    // This engine instance has no live broker (null, null above), so it can
    // only ever execute in PAPER -- but onNewBar reads the real, SHARED
    // SystemState.mode, which the operator may legitimately have set to
    // LIVE for the actual running app. Force PAPER for the duration of this
    // test only (paper is always reachable regardless of broker config, see
    // execution/mode.ts's setMode) and restore whatever was there before,
    // even on failure -- this test must never leave the real system's mode
    // different from how it found it.
    const originalMode = (await getSystemState()).mode;
    await setMode("paper");

    let firstTradeOpenedAtIndex: number | null = null;
    // Captured when the live loop finds the opened trade below -- lets the
    // replay loop assert decideOnBar's own `consensus` (not just each
    // version's individual probability/decision) matches what live actually
    // acted on, at the exact bar the trade opened.
    let openedTradeSnapshot: { strategyId: string; explanation: string } | null = null;
    try {
      // ---- Feed the live path bar-by-bar, exactly as the real system does.
      // Inserting the whole dataset upfront and then calling onNewBar
      // bar-by-bar would let loadRecentBars see bars from the "future"
      // relative to whichever bar is being decided -- precisely the
      // look-ahead this whole effort exists to prevent, so this test would
      // be lying about the thing it's supposed to verify if it did that.
      for (let i = 0; i < allBars.length; i++) {
        const b = allBars[i]!;
        await prisma.bar.create({
          data: {
            time: b.time, symbol: SYMBOL,
            open: b.open.toString(), high: b.high.toString(), low: b.low.toString(),
            close: b.close.toString(), volume: b.volume.toString(),
          },
        });
        if (i + 1 < MIN_BARS_FOR_REGIME) continue;

        await engine.onNewBar(
          SYMBOL, b.time,
          new Decimal(b.open), new Decimal(b.high), new Decimal(b.low), new Decimal(b.close), new Decimal(b.volume),
        );

        const openTrade = await prisma.trade.findFirst({ where: { accountId: account.id, symbol: SYMBOL, status: "open" } });
        if (openTrade) {
          firstTradeOpenedAtIndex = i;
          openedTradeSnapshot = { strategyId: openTrade.strategyId, explanation: openTrade.explanation };
          break; // see file header's SCOPE NOTE
        }
      }

      // If this synthetic fixture never actually produces a trade, the test
      // below would vacuously pass without exercising anything -- fail loud
      // instead of silently proving nothing.
      expect(firstTradeOpenedAtIndex, "fixture never triggered a live entry -- adjust makeTrendingBars' params, this test proves nothing otherwise").not.toBeNull();

      const liveScores = await prisma.score.findMany({
        where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } },
        orderBy: [{ time: "asc" }],
      });
      expect(liveScores.length).toBeGreaterThan(0);

      // ---- Replay the identical window bar-by-bar via decideOnBar directly
      // (not runReplay -- that also simulates fills/exits, which pulls in
      // the fill-timing divergence the SCOPE NOTE above describes, and isn't
      // needed for a pure decision-equivalence check).
      const barsUpToTrade = allBars.slice(0, firstTradeOpenedAtIndex! + 1);
      const riskLimitsRow = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
      const riskLimits = {
        perTradeRiskPct: new Decimal(riskLimitsRow.perTradeRiskPct.toString()),
        maxDailyLossPct: new Decimal(riskLimitsRow.maxDailyLossPct.toString()),
        maxTrailingDrawdownPct: new Decimal(riskLimitsRow.maxTrailingDrawdownPct.toString()),
        maxConsecutiveLosses: riskLimitsRow.maxConsecutiveLosses,
        maxDailyTrades: riskLimitsRow.maxDailyTrades,
        maxPositionSize: riskLimitsRow.maxPositionSize,
        perTradeRiskDollars: riskLimitsRow.perTradeRiskDollars ? new Decimal(riskLimitsRow.perTradeRiskDollars.toString()) : null,
        perTradeProfitDollars: riskLimitsRow.perTradeProfitDollars ? new Decimal(riskLimitsRow.perTradeProfitDollars.toString()) : null,
        maxDailyLossDollars: riskLimitsRow.maxDailyLossDollars ? new Decimal(riskLimitsRow.maxDailyLossDollars.toString()) : null,
      };

      // No trade closed anywhere in this window (we stopped at the FIRST
      // entry), so a fresh synthetic account starting from the account's
      // real starting balance has identical equity/drawdown state to what
      // live actually had throughout -- this is the one window where that's
      // guaranteed true regardless of the fill-timing divergence.
      const barsBySymbol = new Map([[SYMBOL, barsUpToTrade]]);
      const ctx = new ReplayDecisionContext(barsBySymbol, Number(account.startingBalance.toString()), riskLimits);

      for (let i = MIN_BARS_FOR_REGIME - 1; i < barsUpToTrade.length; i++) {
        const b = barsUpToTrade[i]!;
        ctx.advanceTo(b.time);
        ctx.updateLastPrice(SYMBOL, new Decimal(b.close));
        const replayDecisions = await decideOnBar({ ctx, symbol: SYMBOL, barTime: b.time, closePrice: new Decimal(b.close) });

        const liveScoresForBar = liveScores.filter((s) => s.time.getTime() === b.time.getTime());
        if (liveScoresForBar.length === 0) {
          expect(replayDecisions.every((d) => d.gatedByVersion.size === 0), `replay scored something live didn't on ${b.time.toISOString()}`).toBe(true);
          continue;
        }

        for (const liveScore of liveScoresForBar) {
          const version = liveScore.strategyVersion as "v1" | "v2" | "v3" | "v5";
          // Matched by strategyId, not just version -- if two strategies
          // both fired on the same bar, each gets its own v1/v2/v3/v5 rows,
          // and version alone can't tell them apart.
          const matchingDecision = replayDecisions.find((d) => d.signal?.strategyId === liveScore.strategyId);
          expect(matchingDecision, `no replay decision for strategy "${liveScore.strategyId}" on ${b.time.toISOString()}`).toBeDefined();
          const replayGated = matchingDecision!.gatedByVersion.get(version);
          expect(replayGated, `replay decision for "${liveScore.strategyId}" on ${b.time.toISOString()} has no ${version} score`).toBeDefined();
          expect(replayGated!.decision, `${version} decision mismatch on ${b.time.toISOString()}`).toBe(liveScore.decision);
          expect(replayGated!.probability, `${version} probability mismatch on ${b.time.toISOString()}`).toBeCloseTo(Number(liveScore.probability.toString()), 4);
        }

        // Bar-level check, not just per-version: at the exact bar live opened
        // its trade, replay's own determineConsensus call must have reached
        // the same conclusion for the same strategy -- not merely produced
        // matching individual v1/v2/v3/v5 probabilities. execution/engine.ts's
        // executeIfApproved builds every real trade's explanation as
        // `CONSENSUS [${consensus.summary}]. ...` (engine/loop.ts's
        // decisionExplanationPrefix), so the live trade row's stored summary
        // string is a direct, already-persisted fingerprint of live's
        // consensus.taken + representativeVersion decision -- comparing it
        // to replay's consensus.summary here is a stronger check than
        // reimplementing the comparison field-by-field.
        if (i === barsUpToTrade.length - 1 && openedTradeSnapshot) {
          const tradeDecision = replayDecisions.find((d) => d.signal?.strategyId === openedTradeSnapshot!.strategyId);
          expect(tradeDecision, `no replay decision for the strategy ("${openedTradeSnapshot.strategyId}") whose trade live actually opened on ${b.time.toISOString()}`).toBeDefined();
          expect(tradeDecision!.consensus.taken, `replay did not reach consensus on the bar live opened a trade on (${b.time.toISOString()})`).toBe(true);
          expect(tradeDecision!.consensus.representativeVersion, "replay consensus reached but has no representativeVersion").not.toBeNull();
          expect(tradeDecision!.plan?.approved, `replay's risk assessment did not approve the trade live actually opened on ${b.time.toISOString()}`).toBe(true);
          const liveSummaryPrefix = `CONSENSUS [${tradeDecision!.consensus.summary}]. `;
          expect(openedTradeSnapshot.explanation.startsWith(liveSummaryPrefix), "live trade's stored consensus summary does not match replay's consensus.summary").toBe(true);
        }
      }
    } finally {
      // Direct write, not setMode() -- restoring to LIVE would hit setMode's
      // own liveBrokerConnected check, which is false in THIS process (this
      // test's Node process never ran index.ts's real broker-connect
      // startup sequence, unlike the actual running app). This is pure
      // restoration of whatever was already legitimately there, not a new
      // escalation to live, so bypassing the gate here is correct, not a
      // workaround of it.
      await prisma.systemState.update({ where: { id: 1 }, data: { mode: originalMode } });
      // Scoped to the synthetic time range, not the symbol -- "ES" is a real
      // instrument other rows in a shared test DB may legitimately use.
      await prisma.orderRecord.deleteMany({ where: { symbol: SYMBOL, trade: { entryTime: { gte: SYNTHETIC_START } } } });
      await prisma.trade.deleteMany({ where: { symbol: SYMBOL, entryTime: { gte: SYNTHETIC_START } } });
      await prisma.score.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });
      await prisma.bar.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });
    }
  });
});
