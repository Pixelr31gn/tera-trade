// One-off analysis run (2026-08-02, operator request): replay every 5-minute
// bar of the real historical backfill through the live decision pipeline
// (src/replay/), and dump every EXECUTED trade's entry features + resolved
// outcome to a JSON file for pattern mining -- the same goal ruleScorerV5.ts
// was built from (real asymmetric patterns in resolved outcomes), just
// sourced from replay instead of live trade history, since this deployment
// doesn't have enough live data yet (0 executed_win/executed_loss as of
// 2026-08-02).
//
// Scoped to executed-only (approved-and-opened trades), not the fuller
// taken-and-skipped dataset v5 used -- decideOnBar only resolves a position
// for signals that pass consensus (see decisionCore.ts), so skipped signals
// have features + scores but no forward-simulated outcome. Extending the
// harness to hypothetically resolve every signal is a real follow-up, not
// done here (operator decision: faster first pass over full methodology
// parity). Usage: npx tsx scripts/replayV6Mining.ts
import { Decimal } from "decimal.js";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/db/client.js";
import { runReplay } from "../src/replay/harness.js";
import { ReplayDecisionContext } from "../src/replay/replayDecisionContext.js";
import type { ReplayConfig } from "../src/replay/types.js";
import type { RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { OhlcBar } from "../src/regime/indicators.js";
import type { SetupFeatures } from "../src/scoring/features.js";

const SYMBOLS = ["ES", "NQ"];
const OUT_PATH = process.argv[2] ?? "replay-v6-mining.json";
// A full ~74-day run over-ran (killed after 20+ min with no result, 2026-08-02)
// -- operator called for a much shorter window instead, fast enough to
// actually finish and iterate on, at the cost of fewer samples. Defaults to
// 7 days; pass a different value as argv[3] (e.g. `npx tsx ... out.json 21`).
const LOOKBACK_DAYS = process.argv[3] ? Number(process.argv[3]) : 7;

async function loadBars(symbol: string): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({ where: { symbol }, orderBy: { time: "asc" } });
  return rows.map((r) => ({
    time: r.time, open: r.open.toNumber(), high: r.high.toNumber(), low: r.low.toNumber(), close: r.close.toNumber(), volume: r.volume.toNumber(),
  }));
}

async function main() {
  console.log("loading historical bars...");
  const barsBySymbol = new Map<string, OhlcBar[]>();
  for (const symbol of SYMBOLS) {
    const bars = await loadBars(symbol);
    barsBySymbol.set(symbol, bars);
    console.log(`  ${symbol}: ${bars.length} bars, ${bars[0]?.time.toISOString()} -> ${bars.at(-1)?.time.toISOString()}`);
  }

  const allTimes = [...barsBySymbol.values()].flat().map((b) => b.time.getTime());
  const to = new Date(Math.max(...allTimes));
  const from = new Date(Math.max(Math.min(...allTimes), to.getTime() - LOOKBACK_DAYS * 86_400_000));

  // Mirrors the real paper account's actual configured risk_limits row
  // (account id=1) -- not invented, read directly from the live DB before
  // writing this.
  const limits: RiskLimitsConfig = {
    perTradeRiskPct: new Decimal("0.5"),
    maxDailyLossPct: new Decimal("3.0"),
    maxTrailingDrawdownPct: new Decimal("6.0"),
    maxConsecutiveLosses: 3,
    maxDailyTrades: 8,
    maxPositionSize: 3,
    perTradeRiskDollars: null,
    perTradeProfitDollars: null,
    maxDailyLossDollars: null,
  };

  const config: ReplayConfig = {
    symbols: SYMBOLS,
    from,
    to,
    startingEquity: 50_000,
    warmupBars: 300,
    // NOT sourced from evidence -- see ReplayConfig's own comment. Pattern
    // mining below looks at RELATIVE outcomes across feature buckets, which
    // a flat per-trade commission shifts uniformly rather than distorting,
    // but absolute R/expectancy numbers from this run understate real cost.
    commissionPerContractPerSide: 0,
  };

  const ctx = new ReplayDecisionContext(barsBySymbol, config.startingEquity, limits);

  console.log(`running replay: ${from.toISOString()} -> ${to.toISOString()}...`);
  const started = Date.now();
  const result = await runReplay(config, ctx, barsBySymbol);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  decisions: ${result.decisions.length}, trades: ${result.trades.length}, degradationRate: ${(result.degradationRate * 100).toFixed(1)}%`);
  console.log(`  killSwitchTrippedAt: ${result.killSwitchTrippedAt?.toISOString() ?? "never"}`);
  console.log(`  metrics:`, result.metrics);

  // Zip each symbol's approved decisions with its resolved trades, in
  // chronological order -- decideOnBar only builds `plan` when consensus was
  // reached (decisionCore.ts), and harness.ts opens a position immediately
  // (next bar) for every approved plan when the symbol is flat, so within a
  // symbol the two sequences are 1:1 and already time-ordered.
  const rows: Array<{ features: SetupFeatures; strategyId: string; representativeVersion: string | null; side: string; rMultiple: number; pnl: number; exitReason: string; entryTime: string }> = [];
  for (const symbol of SYMBOLS) {
    const approvedDecisions = result.decisions.filter((d) => d.symbol === symbol && d.plan?.approved).sort((a, b) => a.barTime.getTime() - b.barTime.getTime());
    const trades = result.trades.filter((t) => t.symbol === symbol).sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
    if (approvedDecisions.length !== trades.length) {
      console.warn(`  WARNING: ${symbol} approved-decision count (${approvedDecisions.length}) != trade count (${trades.length}) -- zip may misalign`);
    }
    const n = Math.min(approvedDecisions.length, trades.length);
    for (let i = 0; i < n; i++) {
      const d = approvedDecisions[i]!;
      const t = trades[i]!;
      if (!d.features || !d.signal) continue;
      rows.push({
        features: d.features,
        strategyId: d.signal.strategyId,
        representativeVersion: d.consensus.representativeVersion,
        side: t.side,
        rMultiple: t.rMultiple,
        pnl: t.pnl,
        exitReason: t.exitReason,
        entryTime: t.entryTime.toISOString(),
      });
    }
  }

  writeFileSync(OUT_PATH, JSON.stringify({ config: { ...config, from: from.toISOString(), to: to.toISOString() }, metrics: result.metrics, degradationRate: result.degradationRate, rowCount: rows.length, rows }, null, 2));
  console.log(`wrote ${rows.length} labeled rows to ${OUT_PATH}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
