/**
 * One-off backtest (2026-08-12, operator claim: "any time the 20 ema and
 * the 200 ema cross each other... price changes direction every single
 * time guaranteed" -- proposed as a hard long/short gate: only trade short
 * after 200 EMA crosses above 20 EMA, only trade long after 20 EMA crosses
 * back above 200 EMA).
 *
 * Tests this against the real ~12-year daily bar history (backfilled
 * earlier this session) for both ES and NQ: finds every real 20/200 EMA
 * crossover, measures what actually happened afterward (forward returns at
 * several horizons, and the return of literally holding the implied
 * direction until the next crossover), rather than assuming the "every
 * single time guaranteed" claim holds without checking.
 */
import { prisma } from "../src/db/client.js";
import { ema } from "../src/analytics/emaTrend.js";

const SYMBOLS = ["ES", "NQ"];
const HORIZONS = [5, 10, 20, 40, 60] as const;
const FAST_PERIOD = 20;
const SLOW_PERIOD = 200;

interface Crossover {
  index: number;
  date: Date;
  direction: "bullish" | "bearish"; // bullish = 20 crosses ABOVE 200 (implies long); bearish = 20 crosses BELOW 200 (implies short)
  price: number;
}

function findCrossovers(closes: number[], dates: Date[], fast: number[], slow: number[]): Crossover[] {
  const crossovers: Crossover[] = [];
  for (let i = SLOW_PERIOD + 1; i < closes.length; i++) {
    const prevDiff = fast[i - 1]! - slow[i - 1]!;
    const currDiff = fast[i]! - slow[i]!;
    if (prevDiff <= 0 && currDiff > 0) {
      crossovers.push({ index: i, date: dates[i]!, direction: "bullish", price: closes[i]! });
    } else if (prevDiff >= 0 && currDiff < 0) {
      crossovers.push({ index: i, date: dates[i]!, direction: "bearish", price: closes[i]! });
    }
  }
  return crossovers;
}

function stats(rets: number[]) {
  if (rets.length === 0) return { n: 0, meanPct: 0, posFraction: 0 };
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const pos = rets.filter((r) => r > 0).length / rets.length;
  return { n: rets.length, meanPct: mean * 100, posFraction: pos };
}

async function main() {
  for (const symbol of SYMBOLS) {
    console.log(`\n========== ${symbol} ==========`);
    const rows = await prisma.dailyBar.findMany({ where: { symbol }, orderBy: { date: "asc" } });
    const closes = rows.map((r) => Number(r.close));
    const dates = rows.map((r) => r.date);
    console.log(`total daily bars: ${closes.length}, range: ${dates[0]?.toISOString().slice(0, 10)} -> ${dates.at(-1)?.toISOString().slice(0, 10)}`);

    const fast = ema(closes, FAST_PERIOD);
    const slow = ema(closes, SLOW_PERIOD);
    const crossovers = findCrossovers(closes, dates, fast, slow);
    console.log(`crossovers found: ${crossovers.length} (${crossovers.filter((c) => c.direction === "bullish").length} bullish, ${crossovers.filter((c) => c.direction === "bearish").length} bearish)`);

    for (const c of crossovers) {
      console.log(`  ${c.date.toISOString().slice(0, 10)} ${c.direction.padEnd(8)} @ ${c.price.toFixed(2)}`);
    }

    // Forward-return test: does price move in the "guaranteed" direction after each cross?
    for (const horizon of HORIZONS) {
      const bullishRets: number[] = [];
      const bearishRets: number[] = [];
      for (const c of crossovers) {
        const future = closes[c.index + horizon];
        if (future === undefined) continue;
        const ret = (future - c.price) / c.price;
        // "Correct" direction: bullish cross implies UP move is the win; bearish cross implies DOWN move is the win.
        const directional = c.direction === "bullish" ? ret : -ret;
        (c.direction === "bullish" ? bullishRets : bearishRets).push(directional);
      }
      const bs = stats(bullishRets);
      const bes = stats(bearishRets);
      console.log(`\n-- ${horizon}-day forward return in the CROSS-IMPLIED direction --`);
      console.log(`  bullish cross (went long): n=${bs.n} mean=${bs.meanPct.toFixed(3)}% pos=${(bs.posFraction * 100).toFixed(1)}%`);
      console.log(`  bearish cross (went short): n=${bes.n} mean=${bes.meanPct.toFixed(3)}% pos=${(bes.posFraction * 100).toFixed(1)}%`);
    }

    // Regime-hold test: literally the proposed strategy -- hold the implied
    // direction from each crossover until the NEXT crossover reverses it.
    const holdRets: number[] = [];
    for (let i = 0; i < crossovers.length - 1; i++) {
      const entry = crossovers[i]!;
      const exit = crossovers[i + 1]!;
      const ret = (exit.price - entry.price) / entry.price;
      const directional = entry.direction === "bullish" ? ret : -ret;
      holdRets.push(directional);
    }
    const hs = stats(holdRets);
    console.log(`\n-- Hold cross-implied direction until the NEXT crossover (the literal proposed strategy) --`);
    console.log(`  n=${hs.n} mean=${hs.meanPct.toFixed(3)}% pos=${(hs.posFraction * 100).toFixed(1)}%`);
    console.log(`  individual trades: ${holdRets.map((r) => (r * 100).toFixed(2) + "%").join(", ")}`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
