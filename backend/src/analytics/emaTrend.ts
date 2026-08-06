/**
 * EMA trend direction + slope -- the sole trend-direction input for v3
 * (scoring/ruleScorerV3.ts). Computed on daily closes (see
 * engine/dailyEmaTrendCache.ts), a genuinely different/slower signal than
 * the intraday bars a strategy actually trades on -- not the daily-bar MA
 * stack in movingAverages.ts either (a separate, coarser reference used for
 * the manual Quick Order Panel). Switched from an intraday EMA(50) to a
 * daily EMA(20) (2026-07-20, operator request); the pure math here is
 * period-agnostic, only the bar series and period passed in changed.
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

export type EmaTrendLabel = "bullish" | "bearish" | "neutral";

export interface EmaTrend {
  ema: number | null;
  /** Normalized slope over the lookback: (now - then) / |then|. Null until enough bars exist. */
  slope: number | null;
  label: EmaTrendLabel;
}

const SLOPE_LOOKBACK_BARS = 10;
// A normalized slope below this magnitude reads as "flat" -- the EMA is
// technically never perfectly flat, so a small dead zone around zero is
// needed for "neutral" to mean anything. NOTE (2026-07-20): this threshold,
// and the 0.002 magnitude-scaling reference in ruleScorerV3.ts's
// scoreEmaTrend, were both hand-set for an intraday EMA(50)'s typical
// slope size. Now that this feeds a daily EMA(20) instead, daily closes
// move by meaningfully different percentages per bar than 1-minute bars did
// -- these two constants haven't been recalibrated for that yet and should
// be revisited once real daily-EMA20 score distributions can be observed.
const FLAT_SLOPE_THRESHOLD = 0.0003;

export function classifyEmaTrend(bars: OhlcBar[], period = 20): EmaTrend {
  const closes = bars.map((b) => b.close);
  if (closes.length < period) return { ema: null, slope: null, label: "neutral" };

  const emaSeries = ema(closes, period);
  const emaValue = emaSeries.at(-1)!;
  const lastClose = closes.at(-1)!;

  let slope: number | null = null;
  if (emaSeries.length > SLOPE_LOOKBACK_BARS) {
    const nowVal = emaSeries.at(-1)!;
    const pastVal = emaSeries.at(-1 - SLOPE_LOOKBACK_BARS)!;
    slope = pastVal !== 0 ? (nowVal - pastVal) / Math.abs(pastVal) : null;
  }

  let label: EmaTrendLabel = "neutral";
  if (slope !== null) {
    if (lastClose > emaValue && slope > FLAT_SLOPE_THRESHOLD) label = "bullish";
    else if (lastClose < emaValue && slope < -FLAT_SLOPE_THRESHOLD) label = "bearish";
  }

  return { ema: emaValue, slope, label };
}
