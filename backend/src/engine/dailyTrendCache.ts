/**
 * Daily-timeframe trend regime, cached per symbol.
 *
 * The intraday regime (regime/classifier.ts fed 300 recent 1-minute bars)
 * can flip direction within the same session as short-term noise passes
 * through -- that's what was producing long/short/short/long whipsaw in the
 * recommendation feed, since each strategy's signal only had to agree with
 * whatever the *intraday* regime happened to be at that exact bar. The daily
 * trend is far stickier (computed from ~1 year of daily closes) and is used
 * by scoring/ruleScorer.ts as a much harder-to-clear filter: a setup that
 * fights a confident daily trend should rarely score high enough to take,
 * regardless of what the last few minutes of price action looked like.
 */
import { prisma } from "../db/client.js";
import { classifyRegime, type RegimeResult } from "../regime/classifier.js";
import type { OhlcBar } from "../regime/indicators.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // the daily trend moves slowly -- no need to recompute every tick
// classifyRegime's longest-period indicator (atrPercentile, see
// regime/indicators.ts) wants up to a 100-bar lookback plus its own 14-bar
// ATR warm-up -- ~114 trading days. 200 calendar days gives ~138 trading
// days after accounting for weekends (a comfortable margin, including
// holidays), while pulling meaningfully fewer rows than the previous
// 250-day window.
const LOOKBACK_DAYS = 200;

const cache = new Map<string, { regime: RegimeResult; computedAt: number }>();

async function loadDailyBars(symbol: string): Promise<OhlcBar[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const rows = await prisma.dailyBar.findMany({ where: { symbol, date: { gte: since } }, orderBy: { date: "asc" } });
  return rows.map((r) => ({ time: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

export async function getDailyTrend(symbol: string): Promise<RegimeResult> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.regime;

  const bars = await loadDailyBars(symbol);
  const regime = classifyRegime(bars);

  cache.set(symbol, { regime, computedAt: Date.now() });
  return regime;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetDailyTrendCacheForTests(): void {
  cache.clear();
}
