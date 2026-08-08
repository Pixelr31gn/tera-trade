/**
 * Intraday 5-minute EMA(20) proximity -- a pullback/continuation-entry
 * signal, distinct from emaTrend.ts's daily EMA(20) trend factor (that one
 * is a slow-moving, once-a-day trend filter; this one tracks the same fast
 * intraday bars a continuous-scan strategy actually trades on). Operator
 * request, 2026-07-28: "the closer the price is to the 20 ma we should
 * favor setup in that area -- if ema is above price short, if ema is below
 * price favor long."
 */
import type { OhlcBar } from "../regime/indicators.js";
import { ema } from "./emaTrend.js";

const INTRADAY_EMA_PERIOD = 20;
const BUCKET_MINUTES = 5;

/**
 * Aggregates ascending-time 1-minute bars into `bucketMinutes`-sized OHLCV
 * bars, bucketed to wall-clock boundaries (same alignment convention as
 * marketData/minuteBarAggregator.ts's own minuteKey) so a gap in the source
 * data doesn't shift later buckets' boundaries.
 */
export function aggregateBars(bars: OhlcBar[], bucketMinutes: number): OhlcBar[] {
  const bucketMs = bucketMinutes * 60_000;
  const buckets = new Map<number, OhlcBar>();
  for (const bar of bars) {
    const key = Math.floor(bar.time.getTime() / bucketMs) * bucketMs;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { time: new Date(key), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close; // `bars` is ascending-time, so the latest source bar wins
      existing.volume += bar.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time.getTime() - b.time.getTime());
}

/**
 * Signed distance from the current price to the intraday 5-minute EMA(20),
 * in ATR units. Positive means price is ABOVE the EMA, negative means below
 * -- null until there are at least 20 five-minute bars or no valid ATR.
 */
export function intraday5mEmaDistanceAtr(bars: OhlcBar[], atrValue: number | null): number | null {
  if (!atrValue || atrValue <= 0) return null;
  const fiveMinBars = aggregateBars(bars, BUCKET_MINUTES);
  const closes = fiveMinBars.map((b) => b.close);
  if (closes.length < INTRADAY_EMA_PERIOD) return null;

  const emaValue = ema(closes, INTRADAY_EMA_PERIOD).at(-1)!;
  const lastClose = closes.at(-1)!;
  return (lastClose - emaValue) / atrValue;
}
