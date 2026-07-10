/**
 * Opening-range breakout stats need far more history than the ~300-bar
 * rolling window the regime/ATR calculations use (multiple trading sessions,
 * not minutes) -- this queries a wide slice of bars_1m directly and caches
 * the result per symbol, since recomputing a multi-day backtest on every
 * single price tick would be wasteful.
 */
import { prisma } from "../db/client.js";
import { computeOpeningRangeStats, type OpeningRangeStats } from "../analytics/openingRange.js";
import { getInstrument } from "../marketData/instruments.js";
import type { OhlcBar } from "../regime/indicators.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- this stat moves slowly, no need to recompute every tick
const LOOKBACK_DAYS = 90;

const cache = new Map<string, { stats: OpeningRangeStats; computedAt: number }>();

async function loadWideBarHistory(symbol: string): Promise<OhlcBar[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const rows = await prisma.bar.findMany({ where: { symbol, time: { gte: since } }, orderBy: { time: "asc" } });
  return rows.map((r) => ({ time: r.time, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

const EMPTY_STATS_TEMPLATE: Omit<OpeningRangeStats, "symbol"> = {
  sessionsAnalyzed: 0,
  probHighBroken: null,
  probLowBroken: null,
  probBothBroken: null,
  probNeitherBroken: null,
};

export async function getOpeningRangeStats(symbol: string): Promise<OpeningRangeStats> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.stats;

  // A symbol outside the static instrument list (e.g. a synthetic test
  // fixture) has no rthOpen hours to analyze against -- report "not enough
  // data" rather than crashing the whole engine loop over one stat.
  let instrument;
  try {
    instrument = getInstrument(symbol);
  } catch {
    return { symbol, ...EMPTY_STATS_TEMPLATE };
  }

  const bars = await loadWideBarHistory(symbol);
  const stats = computeOpeningRangeStats(bars, symbol, instrument.rthOpenHourET, instrument.rthOpenMinuteET);

  cache.set(symbol, { stats, computedAt: Date.now() });
  return stats;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetOpeningRangeCacheForTests(): void {
  cache.clear();
}
