/**
 * One-off backtest (2026-08-12, same-day follow-up to
 * backtestEma20Ema200Cross.ts): the operator clarified the crossover claim
 * is about the 5-MINUTE chart, not daily -- a real example cited (Tuesday
 * 21:55, 20 EMA crossing above the 200 MA on MNQU26's 5m chart, screenshot
 * provided). Re-tests the same "guaranteed direction change" claim against
 * real 5-minute bars_1m history (this session's live/backfilled data, ~3.7
 * months for ES/NQ -- far more crossovers than the daily test's 20/symbol,
 * so a statistically meaningful sample actually exists here). Tests both a
 * 200-period EMA and a 200-period SMA against the 20 EMA, since the
 * operator said "200 ema" once and "200 ma" once -- the chart's slow line
 * could be either.
 */
import { prisma } from "../src/db/client.js";
import { ema } from "../src/analytics/emaTrend.js";

const SYMBOLS = ["ES", "NQ"];
// 5-minute-bar horizons: 15min, 30min, 1h, 2h, 4h, 8h
const HORIZONS_BARS = [3, 6, 12, 24, 48, 96] as const;
const FAST_PERIOD = 20;
const SLOW_PERIOD = 200;

function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

interface Crossover {
  index: number;
  time: Date;
  direction: "bullish" | "bearish";
  price: number;
}

function findCrossovers(closes: number[], times: Date[], fast: number[], slow: number[], startIdx: number): Crossover[] {
  const crossovers: Crossover[] = [];
  for (let i = startIdx + 1; i < closes.length; i++) {
    if (Number.isNaN(slow[i - 1]) || Number.isNaN(slow[i])) continue;
    const prevDiff = fast[i - 1]! - slow[i - 1]!;
    const currDiff = fast[i]! - slow[i]!;
    if (prevDiff <= 0 && currDiff > 0) crossovers.push({ index: i, time: times[i]!, direction: "bullish", price: closes[i]! });
    else if (prevDiff >= 0 && currDiff < 0) crossovers.push({ index: i, time: times[i]!, direction: "bearish", price: closes[i]! });
  }
  return crossovers;
}

function stats(rets: number[]) {
  if (rets.length === 0) return { n: 0, meanPct: 0, posFraction: 0, avgWinPct: 0, avgLossPct: 0, expectancyPct: 0 };
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);
  const pos = wins.length / rets.length;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  // Same expectancy formula as the real trade stats (winRate*avgWin + lossRate*avgLoss) --
  // for direct apples-to-apples comparison against real trades' $ expectancy.
  const expectancy = pos * avgWin + (1 - pos) * avgLoss;
  return { n: rets.length, meanPct: mean * 100, posFraction: pos, avgWinPct: avgWin * 100, avgLossPct: avgLoss * 100, expectancyPct: expectancy * 100 };
}

function runTest(label: string, closes: number[], times: Date[], slowSeries: number[], startIdx: number) {
  const fast = ema(closes, FAST_PERIOD);
  const crossovers = findCrossovers(closes, times, fast, slowSeries, startIdx);
  console.log(`\n--- ${label}: ${crossovers.length} crossovers (${crossovers.filter((c) => c.direction === "bullish").length} bullish, ${crossovers.filter((c) => c.direction === "bearish").length} bearish) ---`);

  for (const horizon of HORIZONS_BARS) {
    const bullishRets: number[] = [];
    const bearishRets: number[] = [];
    for (const c of crossovers) {
      const future = closes[c.index + horizon];
      if (future === undefined) continue;
      const ret = (future - c.price) / c.price;
      const directional = c.direction === "bullish" ? ret : -ret;
      (c.direction === "bullish" ? bullishRets : bearishRets).push(directional);
    }
    const bs = stats(bullishRets);
    const bes = stats(bearishRets);
    const minutes = horizon * 5;
    console.log(`  +${horizon} bars (${minutes}min):`);
    console.log(`    long : n=${bs.n} pos=${(bs.posFraction * 100).toFixed(1)}% avgWin=${bs.avgWinPct.toFixed(4)}% avgLoss=${bs.avgLossPct.toFixed(4)}% payoutRatio=${bs.avgLossPct !== 0 ? Math.abs(bs.avgWinPct / bs.avgLossPct).toFixed(2) : "n/a"}  expectancy=${bs.expectancyPct.toFixed(4)}%/trade`);
    console.log(`    short: n=${bes.n} pos=${(bes.posFraction * 100).toFixed(1)}% avgWin=${bes.avgWinPct.toFixed(4)}% avgLoss=${bes.avgLossPct.toFixed(4)}% payoutRatio=${bes.avgLossPct !== 0 ? Math.abs(bes.avgWinPct / bes.avgLossPct).toFixed(2) : "n/a"}  expectancy=${bes.expectancyPct.toFixed(4)}%/trade`);
  }

  const holdRets: number[] = [];
  const holdDurationsBars: number[] = [];
  for (let i = 0; i < crossovers.length - 1; i++) {
    const entry = crossovers[i]!;
    const exit = crossovers[i + 1]!;
    const ret = (exit.price - entry.price) / entry.price;
    holdRets.push(entry.direction === "bullish" ? ret : -ret);
    holdDurationsBars.push(exit.index - entry.index);
  }
  const hs = stats(holdRets);
  console.log(`  hold until next crossover: n=${hs.n} pos=${(hs.posFraction * 100).toFixed(1)}% avgWin=${hs.avgWinPct.toFixed(3)}% avgLoss=${hs.avgLossPct.toFixed(3)}% payoutRatio=${hs.avgLossPct !== 0 ? Math.abs(hs.avgWinPct / hs.avgLossPct).toFixed(2) : "n/a"}  expectancy=${hs.expectancyPct.toFixed(4)}%/trade`);

  // How long was each simulated trade actually held, and does duration
  // correlate with outcome? Buckets in minutes: <15, 15-30, 30-60, 1-2h,
  // 2-4h, 4-8h, 8-24h, 1d+.
  const bucketBoundsMin = [15, 30, 60, 120, 240, 480, 1440, Infinity];
  const bucketLabels = ["<15min", "15-30min", "30-60min", "1-2h", "2-4h", "4-8h", "8-24h", "1d+"];
  const buckets: { label: string; rets: number[] }[] = bucketLabels.map((label) => ({ label, rets: [] }));
  for (let i = 0; i < holdRets.length; i++) {
    const minutes = holdDurationsBars[i]! * 5;
    const bucketIdx = bucketBoundsMin.findIndex((bound) => minutes <= bound);
    buckets[bucketIdx]!.rets.push(holdRets[i]!);
  }
  console.log(`  trade duration breakdown (${holdRets.length} total simulated trades):`);
  for (const b of buckets) {
    if (b.rets.length === 0) continue;
    const s = stats(b.rets);
    console.log(`    ${b.label.padEnd(10)}: n=${s.n} (${((s.n / holdRets.length) * 100).toFixed(0)}%)  mean=${s.meanPct.toFixed(3)}%  pos=${(s.posFraction * 100).toFixed(1)}%`);
  }

  // Distribution of how long each regime lasted (bars) -- sanity check on whether crossovers are whipsawing.
  const durations = crossovers.slice(1).map((c, i) => c.index - crossovers[i]!.index);
  if (durations.length > 0) {
    const sorted = [...durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    console.log(`  regime duration (bars, 5min each): median=${median} (${median * 5}min), min=${sorted[0]}, max=${sorted.at(-1)}`);
  }
}

async function main() {
  for (const symbol of SYMBOLS) {
    console.log(`\n========== ${symbol} (5-minute bars) ==========`);
    const rows = await prisma.bar.findMany({ where: { symbol }, orderBy: { time: "asc" } });
    const closes = rows.map((r) => Number(r.close));
    const times = rows.map((r) => r.time);
    console.log(`total 5m bars: ${closes.length}, range: ${times[0]?.toISOString()} -> ${times.at(-1)?.toISOString()}`);
    if (closes.length < SLOW_PERIOD + 10) {
      console.log("not enough bars for a 200-period slow MA -- skipping");
      continue;
    }

    const emaSlow = ema(closes, SLOW_PERIOD);
    runTest("20 EMA vs 200 EMA", closes, times, emaSlow, SLOW_PERIOD);

    const smaSlow = sma(closes, SLOW_PERIOD);
    runTest("20 EMA vs 200 SMA", closes, times, smaSlow, SLOW_PERIOD);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
