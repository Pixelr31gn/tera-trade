/**
 * EMA(50) trend direction + slope -- the sole trend-direction input for v3
 * (scoring/ruleScorerV3.ts). Computed on the same intraday bars a strategy
 * trades on, not the daily-bar MA stack in movingAverages.ts (a separate,
 * coarser reference used for the manual Quick Order Panel).
 */
import type { OhlcBar } from "../regime/indicators.js";

export function ema(values: number[], period: number): number[] {
  const alpha = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(alpha * values[i]! + (1 - alpha) * out[i - 1]!);
  }
  return out;
}

export type Ema50TrendLabel = "bullish" | "bearish" | "neutral";

export interface Ema50Trend {
  ema50: number | null;
  /** Normalized slope over the lookback: (now - then) / |then|. Null until enough bars exist. */
  slope: number | null;
  label: Ema50TrendLabel;
}

const SLOPE_LOOKBACK_BARS = 10;
// A normalized slope below this magnitude reads as "flat" -- EMA50 is
// technically never perfectly flat, so a small dead zone around zero is
// needed for "neutral" to mean anything.
const FLAT_SLOPE_THRESHOLD = 0.0003;

export function classifyEma50Trend(bars: OhlcBar[], period = 50): Ema50Trend {
  const closes = bars.map((b) => b.close);
  if (closes.length < period) return { ema50: null, slope: null, label: "neutral" };

  const emaSeries = ema(closes, period);
  const ema50 = emaSeries.at(-1)!;
  const lastClose = closes.at(-1)!;

  let slope: number | null = null;
  if (emaSeries.length > SLOPE_LOOKBACK_BARS) {
    const nowVal = emaSeries.at(-1)!;
    const pastVal = emaSeries.at(-1 - SLOPE_LOOKBACK_BARS)!;
    slope = pastVal !== 0 ? (nowVal - pastVal) / Math.abs(pastVal) : null;
  }

  let label: Ema50TrendLabel = "neutral";
  if (slope !== null) {
    if (lastClose > ema50 && slope > FLAT_SLOPE_THRESHOLD) label = "bullish";
    else if (lastClose < ema50 && slope < -FLAT_SLOPE_THRESHOLD) label = "bearish";
  }

  return { ema50, slope, label };
}
