// Walk-forward A/B evaluation for the consensus bandit (scoring/consensusBandit.ts)
// -- Phase 4 of the bandit plan. Runs the SAME historical bars through
// decideOnBar twice: once with the bandit forced cold-start (baseline =
// today's plain hasV1V2V3MajorityAgreement rule for the v1/v2/v3/v6/v7 leg),
// once with the bandit live (using whatever real bucket history already
// exists in the DB as of each bar's own time -- computeBanditSelection's
// `time: { lt: at }` bound makes this walk-forward-safe by construction, see
// .claude/rules/replay-harness.md's landmine #6). Reuses
// scripts/replayV6Mining.ts's bar-loading/ReplayConfig-building/runReplay
// boilerplate, dropping its mining-specific JSON dump in favor of a
// per-bucket baseline-vs-variant comparison.
//
// Usage: npx tsx scripts/replayBanditEval.ts [lookbackDays] [explorationConstant] [minBucketSamples] [outPath]
// Defaults: 7 days, scoring/consensusBandit.ts's own UCB_EXPLORATION_CONSTANT/
// MIN_BUCKET_SAMPLES_BEFORE_BANDIT, "replay-bandit-eval.json".
import { Decimal } from "decimal.js";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/db/client.js";
import { runReplay } from "../src/replay/harness.js";
import { ReplayDecisionContext } from "../src/replay/replayDecisionContext.js";
import { computeContextBucket } from "../src/analytics/contextBucket.js";
import { UCB_EXPLORATION_CONSTANT, MIN_BUCKET_SAMPLES_BEFORE_BANDIT } from "../src/scoring/consensusBandit.js";
import { computeReplayMetrics } from "../src/replay/metrics.js";
import type { ReplayConfig, ReplayResult, ReplayTrade, BarDecision } from "../src/replay/types.js";
import type { RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const SYMBOLS = ["ES", "NQ"];
const LOOKBACK_DAYS = process.argv[2] ? Number(process.argv[2]) : 7;
const EXPLORATION_CONSTANT = process.argv[3] ? Number(process.argv[3]) : UCB_EXPLORATION_CONSTANT;
const MIN_BUCKET_SAMPLES = process.argv[4] ? Number(process.argv[4]) : MIN_BUCKET_SAMPLES_BEFORE_BANDIT;
const OUT_PATH = process.argv[5] ?? "replay-bandit-eval.json";

async function loadBars(symbol: string): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({ where: { symbol }, orderBy: { time: "asc" } });
  return rows.map((r) => ({
    time: r.time, open: r.open.toNumber(), high: r.high.toNumber(), low: r.low.toNumber(), close: r.close.toNumber(), volume: r.volume.toNumber(),
  }));
}

interface BucketMetrics {
  bucket: string;
  trades: number;
  winRate: number;
  expectancyR: number;
  expectancyStdErr: number;
  profitFactor: number;
}

/** Zips each symbol's approved decisions to its resolved trades in chronological order -- same 1:1 assumption scripts/replayV6Mining.ts already relies on (decideOnBar builds `plan` only when consensus was reached, and runReplay opens a position for every approved plan when the symbol is flat). */
function tradeBuckets(result: ReplayResult): Map<ReplayTrade, string> {
  const bucketByTrade = new Map<ReplayTrade, string>();
  for (const symbol of SYMBOLS) {
    const approvedDecisions = result.decisions
      .filter((d): d is BarDecision & { features: NonNullable<BarDecision["features"]> } => d.symbol === symbol && !!d.plan?.approved && !!d.features)
      .sort((a, b) => a.barTime.getTime() - b.barTime.getTime());
    const trades = result.trades.filter((t) => t.symbol === symbol).sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
    const n = Math.min(approvedDecisions.length, trades.length);
    for (let i = 0; i < n; i++) {
      const d = approvedDecisions[i]!;
      const bucket = computeContextBucket(d.features.session, d.features.trendLabel as "up" | "down" | "none", d.features.volLabel as "high" | "normal" | "low");
      bucketByTrade.set(trades[i]!, bucket);
    }
  }
  return bucketByTrade;
}

function summarizeByBucket(result: ReplayResult): Map<string, BucketMetrics> {
  const bucketByTrade = tradeBuckets(result);
  const tradesByBucket = new Map<string, ReplayTrade[]>();
  for (const [trade, bucket] of bucketByTrade) {
    const list = tradesByBucket.get(bucket) ?? [];
    list.push(trade);
    tradesByBucket.set(bucket, list);
  }

  const out = new Map<string, BucketMetrics>();
  for (const [bucket, trades] of tradesByBucket) {
    // Reuse computeReplayMetrics for its expectancy/winRate/stderr math, with
    // an empty equity curve -- maxDrawdown/sharpeApprox aren't meaningful per
    // bucket (a bucket's trades aren't a continuous equity sequence), only at
    // the global-run level, which is reported separately below.
    const m = computeReplayMetrics(trades, [], 0);
    out.set(bucket, {
      bucket,
      trades: (m.trades as number) ?? 0,
      winRate: (m.winRate as number) ?? 0,
      expectancyR: (m.expectancyR as number) ?? 0,
      expectancyStdErr: (m.expectancyStdErr as number) ?? NaN,
      profitFactor: (m.profitFactor as number) ?? 0,
    });
  }
  return out;
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

  // Mirrors the real paper account's actual configured risk_limits row --
  // same values scripts/replayV6Mining.ts already reads directly from the
  // live DB, kept in sync with that script rather than re-derived.
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
    commissionPerContractPerSide: 0, // see ReplayConfig's own comment -- understates real P&L
  };

  console.log(`running BASELINE (bandit forced cold-start) over ${from.toISOString()} -> ${to.toISOString()}...`);
  const baselineCtx = new ReplayDecisionContext(barsBySymbol, config.startingEquity, limits, undefined, { forceColdStart: true });
  const baselineStart = Date.now();
  const baseline = await runReplay(config, baselineCtx, barsBySymbol);
  console.log(`  done in ${((Date.now() - baselineStart) / 1000).toFixed(1)}s -- trades: ${baseline.trades.length}, degradationRate: ${(baseline.degradationRate * 100).toFixed(1)}%`);

  console.log(`running VARIANT (bandit live, explorationConstant=${EXPLORATION_CONSTANT}, minBucketSamples=${MIN_BUCKET_SAMPLES}) over the same window...`);
  const variantCtx = new ReplayDecisionContext(barsBySymbol, config.startingEquity, limits, undefined, {
    explorationConstant: EXPLORATION_CONSTANT,
    minBucketSamples: MIN_BUCKET_SAMPLES,
  });
  const variantStart = Date.now();
  const variant = await runReplay(config, variantCtx, barsBySymbol);
  console.log(`  done in ${((Date.now() - variantStart) / 1000).toFixed(1)}s -- trades: ${variant.trades.length}, degradationRate: ${(variant.degradationRate * 100).toFixed(1)}%`);

  const baselineByBucket = summarizeByBucket(baseline);
  const variantByBucket = summarizeByBucket(variant);
  const allBuckets = new Set([...baselineByBucket.keys(), ...variantByBucket.keys()]);

  console.log("\n=== Per-bucket baseline vs variant (expectancyR +/- stderr, trades) ===");
  const comparison: Array<{ bucket: string; baseline: BucketMetrics | null; variant: BucketMetrics | null }> = [];
  for (const bucket of [...allBuckets].sort()) {
    const b = baselineByBucket.get(bucket) ?? null;
    const v = variantByBucket.get(bucket) ?? null;
    comparison.push({ bucket, baseline: b, variant: v });
    const fmt = (m: BucketMetrics | null) => (m ? `${m.expectancyR.toFixed(3)}R +/- ${m.expectancyStdErr.toFixed(3)} (n=${m.trades}, win%=${(m.winRate * 100).toFixed(0)})` : "n/a");
    console.log(`  ${bucket.padEnd(22)} baseline: ${fmt(b).padEnd(38)} variant: ${fmt(v)}`);
  }

  console.log("\n=== Global run metrics (baseline vs variant) ===");
  console.log("  baseline:", baseline.metrics);
  console.log("  variant: ", variant.metrics);

  // Per the replay-harness rule's walk-forward mandate: this single run is
  // one fit/evaluate pass, not a verdict. Re-run against a held-out LATER
  // window before trusting whatever explorationConstant/minBucketSamples
  // combination looked best here.
  console.log(
    "\nReminder: this is one window. Per .claude/rules/replay-harness.md, re-run this exact config " +
      "against a held-out LATER window before trusting any parameter choice, and treat a result inside " +
      "one standard error of the baseline as 'no evidence of a difference,' not an improvement."
  );

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        config: { ...config, from: from.toISOString(), to: to.toISOString() },
        explorationConstant: EXPLORATION_CONSTANT,
        minBucketSamples: MIN_BUCKET_SAMPLES,
        baseline: { metrics: baseline.metrics, degradationRate: baseline.degradationRate, killSwitchTrippedAt: baseline.killSwitchTrippedAt?.toISOString() ?? null },
        variant: { metrics: variant.metrics, degradationRate: variant.degradationRate, killSwitchTrippedAt: variant.killSwitchTrippedAt?.toISOString() ?? null },
        perBucket: comparison,
      },
      null,
      2
    )
  );
  console.log(`\nwrote report to ${OUT_PATH}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
