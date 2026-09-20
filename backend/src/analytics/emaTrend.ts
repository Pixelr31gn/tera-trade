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

export type Ema20Ema200Regime = "bullish" | "bearish" | null;

/**
 * Which side of the 20/200 EMA crossover price is currently on -- "bullish"
 * when the fast EMA sits above the slow one, "bearish" when below, null
 * until enough bars exist for a real 200-period EMA. Distinct from
 * classifyEmaTrend above (which is a single-EMA slope/proximity read, daily
 * bars only, feeds v3's daily trend-direction factor) -- this is a
 * genuinely different signal (two EMAs crossing, intraday 5-minute bars).
 *
 * Built 2026-08-12 (operator claim: "any time the 20 ema and the 200 ema
 * cross each other... price changes direction every single time
 * guaranteed"). A real 5-minute-bar backtest of that claim
 * (scripts/backtestIntraday20v200Cross.ts, ~3.7 months of ES/NQ bars,
 * 430-500 crossovers/symbol) found negative or flat expectancy in every
 * configuration tested when used as a HARD directional gate held across an
 * entire regime -- an operator-toggleable gate was built on that basis and
 * then cancelled at the operator's request in favor of this: exposing the
 * raw regime as one INPUT among many to v1/v2/v3's existing scorers (see
 * scoring/ruleScorer.ts's ema20Ema200RegimeEdge factor and
 * scoring/ruleScorerV3.ts's computeEma20Ema200RegimeAdjustment), not a
 * standalone veto. Being one bounded input to a multi-factor score is a
 * materially different, unvalidated claim from "guaranteed" as a sole
 * gate -- the backtest above speaks to the latter, not the former; treat
 * the weights on those two factors as hand-set and unproven, same posture
 * as every other hand-set weight in those files, not as backed by that
 * backtest. v5/v6/v7 deliberately do NOT get this factor -- each of those
 * files documents an exact, closed, either operator-specified points
 * budget (v6) or data-mined pattern set (v5, v7) that sums to precisely
 * 100; bolting on an un-mined, hand-set factor would silently break that
 * documented contract. Period-agnostic like ema() itself, but named for
 * the specific 20/200 pair the operator asked about -- callers on a
 * different bar timeframe or period pair should treat the defaults as
 * just that.
 */
export function computeEma20Ema200Regime(bars: OhlcBar[], fastPeriod = 20, slowPeriod = 200): Ema20Ema200Regime {
  const closes = bars.map((b) => b.close);
  if (closes.length < slowPeriod) return null;

  const fast = ema(closes, fastPeriod).at(-1)!;
  const slow = ema(closes, slowPeriod).at(-1)!;
  if (fast === slow) return null; // exactly equal -- no real regime to report, vanishingly unlikely with real prices but not undefined behavior
  return fast > slow ? "bullish" : "bearish";
}

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
