/**
 * Daily EMA(20) trend, cached per symbol -- feeds v3's "trend direction"
 * factor (scoring/ruleScorerV3.ts), replacing an intraday EMA(50) computed
 * off the same 1-minute bars a strategy trades on (2026-07-20, operator
 * request: "we need to use 20 day ema not 50"). This is a real daily-chart
 * indicator, not a period tweak on the same intraday series -- it reads
 * from bars_daily, the same table engine/dailyTrendCache.ts uses for the
 * (separately-purposed) v1/v2 daily-trend-alignment factor.
 */
import { prisma } from "../db/client.js";
import { classifyEmaTrend, type EmaTrend } from "../analytics/emaTrend.js";
import type { OhlcBar } from "../regime/indicators.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // a daily EMA barely moves intraday -- no need to recompute every tick
const EMA_PERIOD = 20;
// EMA(20) fully converges (stops meaningfully reacting to its own warm-up
// seed) well within 60-90 periods -- 90 calendar days gives ~60 trading
// days after weekends/holidays, comfortably past that, without pulling
// anywhere near dailyTrendCache.ts's 200-day regime-classifier window.
const LOOKBACK_DAYS = 90;

const cache = new Map<string, { trend: EmaTrend; computedAt: number }>();

async function loadDailyBars(symbol: string): Promise<OhlcBar[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const rows = await prisma.dailyBar.findMany({ where: { symbol, date: { gte: since } }, orderBy: { date: "asc" } });
  return rows.map((r) => ({ time: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

export async function getDailyEma20Trend(symbol: string): Promise<EmaTrend> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.trend;

  const bars = await loadDailyBars(symbol);
  const trend = classifyEmaTrend(bars, EMA_PERIOD);

  cache.set(symbol, { trend, computedAt: Date.now() });
  return trend;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetDailyEma20TrendCacheForTests(): void {
  cache.clear();
}
