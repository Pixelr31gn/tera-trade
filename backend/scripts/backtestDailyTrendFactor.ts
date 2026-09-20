/**
 * One-off backtest (2026-08-11, operator request: "rebuild v1 v2 v3 based on
 * this data and adjust the rules as needed" -- scoped to the daily-trend
 * factor only, since that's the one part of v1/v2/v3 the new 12-year DAILY
 * backfill actually supports rebuilding; their intraday triggers/factors
 * still only have ~60 days of 5-minute history, unchanged).
 *
 * Tests the core assumption baked into scoring/ruleScorer.ts's
 * dailyTrendAlignment factor: that classifyRegime()'s daily-trend label
 * (computed the exact same way production does -- a rolling 200-calendar-day
 * window of daily bars, see engine/dailyTrendCache.ts) actually predicts
 * forward returns, and that its confidence score scales meaningfully with
 * how reliable that prediction is.
 *
 * Not a replay of live decisions -- this only tests the daily-trend signal
 * in isolation against the real daily bar series, which is what the new
 * backfill actually gives us evidence for.
 */
import { prisma } from "../src/db/client.js";
import { classifyRegime } from "../src/regime/classifier.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const LOOKBACK_DAYS = 200; // matches engine/dailyTrendCache.ts's own window exactly
const MIN_WARMUP_BARS = 120; // classifyRegime's longest indicator wants ~114 trading days
const SYMBOLS = ["ES", "NQ"];
const HORIZONS = [1, 3, 5] as const;

interface Sample {
  trendLabel: "up" | "down" | "none";
  confidence: number;
  forwardReturns: Record<(typeof HORIZONS)[number], number>;
}

async function loadBars(symbol: string): Promise<OhlcBar[]> {
  const rows = await prisma.dailyBar.findMany({ where: { symbol }, orderBy: { date: "asc" } });
  return rows.map((r) => ({ time: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

function buildSamples(bars: OhlcBar[]): Sample[] {
  const samples: Sample[] = [];
  const maxHorizon = Math.max(...HORIZONS);
  for (let i = 0; i < bars.length - maxHorizon; i++) {
    const asOf = bars[i]!.time;
    const windowStart = new Date(asOf.getTime() - LOOKBACK_DAYS * 86_400_000);
    const window = bars.filter((b) => b.time.getTime() >= windowStart.getTime() && b.time.getTime() <= asOf.getTime());
    if (window.length < MIN_WARMUP_BARS) continue;

    const regime = classifyRegime(window);
    const closeToday = bars[i]!.close;
    const forwardReturns = {} as Record<(typeof HORIZONS)[number], number>;
    let skip = false;
    for (const h of HORIZONS) {
      const future = bars[i + h];
      if (!future) {
        skip = true;
        break;
      }
      forwardReturns[h] = (future.close - closeToday) / closeToday;
    }
    if (skip) continue;

    samples.push({ trendLabel: regime.trendLabel, confidence: regime.confidence, forwardReturns });
  }
  return samples;
}

function groupStats(group: Sample[], horizon: (typeof HORIZONS)[number]) {
  if (group.length === 0) return null;
  const rets = group.map((s) => s.forwardReturns[horizon]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const positiveFraction = rets.filter((r) => r > 0).length / rets.length;
  return { n: group.length, meanReturnPct: mean * 100, positiveFraction };
}

function confidenceBuckets(samples: Sample[], trendLabel: "up" | "down", horizon: (typeof HORIZONS)[number]) {
  const filtered = samples.filter((s) => s.trendLabel === trendLabel);
  const buckets = [
    { label: "low conf (0.0-0.33)", min: 0, max: 0.33 },
    { label: "mid conf (0.33-0.66)", min: 0.33, max: 0.66 },
    { label: "high conf (0.66-1.0)", min: 0.66, max: 1.01 },
  ];
  return buckets.map((b) => {
    const group = filtered.filter((s) => s.confidence >= b.min && s.confidence < b.max);
    return { bucket: b.label, ...groupStats(group, horizon) };
  });
}

async function main() {
  for (const symbol of SYMBOLS) {
    console.log(`\n========== ${symbol} ==========`);
    const bars = await loadBars(symbol);
    console.log(`total daily bars: ${bars.length}, range: ${bars[0]?.time.toISOString().slice(0, 10)} -> ${bars[bars.length - 1]?.time.toISOString().slice(0, 10)}`);
    const samples = buildSamples(bars);
    console.log(`usable samples (after ${MIN_WARMUP_BARS}-bar warmup): ${samples.length}`);

    for (const horizon of HORIZONS) {
      console.log(`\n-- ${horizon}-day forward return --`);
      const up = groupStats(samples.filter((s) => s.trendLabel === "up"), horizon);
      const down = groupStats(samples.filter((s) => s.trendLabel === "down"), horizon);
      const none = groupStats(samples.filter((s) => s.trendLabel === "none"), horizon);
      console.log(`  trendLabel=up:   ${JSON.stringify(up)}`);
      console.log(`  trendLabel=down: ${JSON.stringify(down)}`);
      console.log(`  trendLabel=none: ${JSON.stringify(none)}`);

      console.log(`  confidence buckets (up):   ${JSON.stringify(confidenceBuckets(samples, "up", horizon))}`);
      console.log(`  confidence buckets (down): ${JSON.stringify(confidenceBuckets(samples, "down", horizon))}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
