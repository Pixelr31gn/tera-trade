import type { OhlcBar } from "../src/regime/indicators.js";

/** Deterministic pseudo-random generator (mulberry32) so fixtures are reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number, mean: number, std: number): number {
  const u1 = rand() || 1e-9;
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

/**
 * A flat ~30-bar consolidation followed by a clean uptrend. The warmup phase
 * ensures a genuine EMA crossover happens well after bar 23 (the minimum
 * TrendFollowingStrategy needs to evaluate at all) instead of in the noisy
 * first few bars, which would be invisible to any strategy that needs a
 * warm-up window.
 */
export function makeTrendingBars(periods = 200, startPrice = 100, drift = 0.15, noise = 0.3, seed = 42): OhlcBar[] {
  const rand = mulberry32(seed);
  const bars: OhlcBar[] = [];
  let price = startPrice;
  const start = new Date("2026-01-01T00:00:00Z").getTime();
  const warmupBars = 30;

  for (let i = 0; i < periods; i++) {
    const barDrift = i < warmupBars ? 0 : drift;
    price += barDrift + gaussian(rand, 0, noise * 0.3);
    const high = price + Math.abs(gaussian(rand, 0.3, 0.1));
    const low = price - Math.abs(gaussian(rand, 0.3, 0.1));
    const open = price - gaussian(rand, 0, 0.2);
    const volume = 100 + Math.floor(rand() * 900);
    bars.push({ time: new Date(start + i * 60_000), open, high, low, close: price, volume });
  }
  return bars;
}

export function makeRangingBars(periods = 200, midPrice = 100, band = 2, seed = 7): OhlcBar[] {
  const rand = mulberry32(seed);
  const bars: OhlcBar[] = [];
  const start = new Date("2026-01-01T00:00:00Z").getTime();

  for (let i = 0; i < periods; i++) {
    const close = midPrice + band * Math.sin((i / periods) * 12 * Math.PI) + gaussian(rand, 0, 0.05);
    const high = close + Math.abs(gaussian(rand, 0.15, 0.05));
    const low = close - Math.abs(gaussian(rand, 0.15, 0.05));
    const open = close - gaussian(rand, 0, 0.1);
    const volume = 100 + Math.floor(rand() * 900);
    bars.push({ time: new Date(start + i * 60_000), open, high, low, close, volume });
  }
  return bars;
}
