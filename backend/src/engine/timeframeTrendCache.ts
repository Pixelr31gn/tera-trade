/**
 * Higher-timeframe trend regime, cached per symbol+resolution.
 *
 * Covers only the 5 rolled-up legs (4h/1h/30m/15m/5m) of the multi-timeframe
 * alignment factor (see analytics/timeframeAlignment.ts) -- 1d reuses the
 * existing engine/dailyTrendCache.ts directly (it already has its own cache
 * and real ~1yr depth), and 1m is folded in by scoring/features.ts from the
 * intraday `regime` it already computes. Same shape as dailyTrendCache.ts:
 * a TTL-cached classifyRegime() read, just parameterized over bars_rollup's
 * resolutions instead of bars_daily.
 */
import { prisma } from "../db/client.js";
import { classifyRegime } from "../regime/classifier.js";
import type { OhlcBar } from "../regime/indicators.js";
import type { TimeframeTrendReading, TimeframeTrendReadings } from "../analytics/timeframeAlignment.js";

// Same appetite as dailyTrendCache.ts's LOOKBACK_DAYS comment: classifyRegime's
// longest-period indicator (atrPercentile) wants up to a 100-bar lookback
// plus its own 14-bar ATR warm-up -- ~114 bars, regardless of what each bar's
// own duration represents.
const MIN_BARS_FOR_REGIME = 114;
// ~2.2x cushion above MIN_BARS_FOR_REGIME -- enough headroom for
// classifyRegime's internal indicators without pulling unbounded history.
const ROLLUP_QUERY_LIMIT = 250;

interface ResolutionSpec {
  key: "4h" | "1h" | "30m" | "15m" | "5m";
  ttlMs: number;
}

// TTL scales with how often each resolution's data can actually change -- no
// benefit re-reading faster than that. 5m/15m are floored at the rollup
// job's own 5-minute refresh cadence (marketData/rollup.ts); coarser
// resolutions get progressively longer TTLs, roughly 2-3 re-reads per bucket
// lifetime.
const RESOLUTIONS: ResolutionSpec[] = [
  { key: "4h", ttlMs: 60 * 60_000 },
  { key: "1h", ttlMs: 20 * 60_000 },
  { key: "30m", ttlMs: 10 * 60_000 },
  { key: "15m", ttlMs: 5 * 60_000 },
  { key: "5m", ttlMs: 5 * 60_000 },
];

const cache = new Map<string, { reading: TimeframeTrendReading | null; computedAt: number }>();

async function loadRollupBars(symbol: string, resolution: string): Promise<OhlcBar[]> {
  const rows = await prisma.barRollup.findMany({
    where: { symbol, resolution },
    orderBy: { bucket: "desc" },
    take: ROLLUP_QUERY_LIMIT,
  });
  return rows
    .reverse()
    .map((r) => ({ time: r.bucket, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

async function computeReading(symbol: string, spec: ResolutionSpec): Promise<TimeframeTrendReading | null> {
  const bars = await loadRollupBars(symbol, spec.key);
  // Fewer bars than classifyRegime needs -- omit this leg entirely rather
  // than compute a fabricated read off warm-up noise (see
  // analytics/timeframeAlignment.ts: a missing leg is excluded and
  // renormalized around, not treated as a computed-but-neutral reading).
  if (bars.length < MIN_BARS_FOR_REGIME) return null;
  const regime = classifyRegime(bars);
  return { trendLabel: regime.trendLabel, confidence: regime.confidence };
}

async function getReading(symbol: string, spec: ResolutionSpec): Promise<TimeframeTrendReading | null> {
  const key = `${symbol}:${spec.key}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.computedAt < spec.ttlMs) return cached.reading;

  const reading = await computeReading(symbol, spec);
  cache.set(key, { reading, computedAt: Date.now() });
  return reading;
}

/**
 * Returns only the 5 rolled-up legs (4h/1h/30m/15m/5m) -- 1d and 1m are
 * folded in separately by scoring/features.ts's buildSetupFeatures. A
 * resolution with fewer than MIN_BARS_FOR_REGIME rolled-up bars is simply
 * absent from the returned object.
 */
export async function getHigherTimeframeTrends(symbol: string): Promise<TimeframeTrendReadings> {
  const results = await Promise.all(RESOLUTIONS.map((spec) => getReading(symbol, spec)));
  const readings: TimeframeTrendReadings = {};
  RESOLUTIONS.forEach((spec, i) => {
    const reading = results[i]!;
    if (reading) readings[spec.key] = reading;
  });
  return readings;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetTimeframeTrendCacheForTests(): void {
  cache.clear();
}
