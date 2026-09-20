/**
 * Daily EMA(20) trend, cached per symbol -- feeds v3's "trend direction"
 * factor (scoring/ruleScorerV3.ts), replacing an intraday EMA(50) computed
 * off the same 1-minute bars a strategy trades on (2026-07-20, operator
 * request: "we need to use 20 day ema not 50"). This is a real daily-chart
 * indicator, not a period tweak on the same intraday series -- it reads
 * from bars_daily, the same table engine/dailyTrendCache.ts uses for the
 * (separately-purposed) v1/v2 daily-trend-alignment factor.
 */
import { loadDailyBars } from "../marketData/dailyBars.js";
import { classifyEmaTrend, type EmaTrend } from "../analytics/emaTrend.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // a daily EMA barely moves intraday -- no need to recompute every tick
const EMA_PERIOD = 20;
// EMA(20) fully converges (stops meaningfully reacting to its own warm-up
// seed) well within 60-90 periods -- 90 calendar days gives ~60 trading
// days after weekends/holidays, comfortably past that, without pulling
// anywhere near dailyTrendCache.ts's 200-day regime-classifier window.
const LOOKBACK_DAYS = 90;

const cache = new Map<string, { trend: EmaTrend; computedAt: number }>();

export async function getDailyEma20Trend(symbol: string): Promise<EmaTrend> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.trend;

  const bars = await loadDailyBars(symbol, LOOKBACK_DAYS);
  const trend = classifyEmaTrend(bars, EMA_PERIOD);

  cache.set(symbol, { trend, computedAt: Date.now() });
  return trend;
}
