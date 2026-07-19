/**
 * Multi-timeframe trend alignment: combines a trend read from each of 7
 * timeframes (1D down to 1M) into a single -1..1 "does the market, across
 * scales, support this setup's side" signal -- same shape as
 * analytics/fibonacci.ts's fibDirectionSignal / analytics/ppm.ts's
 * ppmDirectionSignal / analytics/orderFlow.ts's orderFlowDirectionSignal,
 * consumed identically by v1/v2 (scoring/ruleScorer.ts) and v3
 * (scoring/ruleScorerV3.ts).
 *
 * Replaces the old single-timeframe dailyTrendAlignment factor (2026-07-18,
 * operator request) -- 1D is now the heaviest-weighted leg inside this
 * composite instead of its own separate factor, so the same daily-trend
 * evidence isn't scored twice in the same setup.
 */

export type TimeframeKey = "1d" | "4h" | "1h" | "30m" | "15m" | "5m" | "1m";

export interface TimeframeTrendReading {
  trendLabel: "up" | "down" | "none";
  confidence: number;
}

/**
 * A missing key means "not enough rolled-up history yet" (see
 * engine/timeframeTrendCache.ts) -- excluded from the composite below, never
 * treated as a computed "none" reading. 1d and 1m are always present (see
 * scoring/features.ts's buildSetupFeatures); the 4h/1h/30m/15m/5m legs may
 * not be for a while after this ships, since bars_1m only recently started
 * accumulating genuinely clean history (see marketData/rollup.ts).
 */
export type TimeframeTrendReadings = Partial<Record<TimeframeKey, TimeframeTrendReading>>;

// Hand-set descending scale, not proportional to raw bar duration (a literal
// 1440:1 1d:1m ratio would make every timeframe below 1d irrelevant). 1d
// anchors as the single heaviest leg -- it's still the stickiest, least-noisy
// read (this is what dailyTrendAlignment alone used to be) -- and each step
// down carries a meaningful but shrinking share, so several lower timeframes
// agreeing can still meaningfully move the composite even against 1d, per the
// operator's "nudge, not gate" framing for this factor.
export const TIMEFRAME_WEIGHTS: Record<TimeframeKey, number> = {
  "1d": 6,
  "4h": 5,
  "1h": 4,
  "30m": 3,
  "15m": 2,
  "5m": 1.5,
  "1m": 1,
};

function clip(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

// Same asymmetric shape the old dailyTrendAlignment factor used (see
// scoring/ruleScorer.ts): agreeing with a leg's trend scores +confidence,
// fighting it is penalized more than agreeing is rewarded (floored at -1),
// and no clear trend at that timeframe is a small flat penalty rather than
// neutral -- ranging conditions are mildly unfavorable at every timeframe,
// not just daily.
function legSignal(reading: TimeframeTrendReading, side: "long" | "short"): number {
  if (reading.trendLabel === "none") return -0.2;
  const direction = side === "long" ? 1 : -1;
  const aligned = (reading.trendLabel === "up" && direction === 1) || (reading.trendLabel === "down" && direction === -1);
  return aligned ? reading.confidence : -clip(0.6 + reading.confidence);
}

/**
 * Weighted average across whatever timeframes are actually available,
 * renormalized so a missing leg (e.g. 4h for the first couple of weeks) is
 * excluded rather than diluting the result toward 0. Returns 0 (neutral)
 * only if literally no timeframe has enough data yet.
 */
export function timeframeAlignmentSignal(readings: TimeframeTrendReadings, side: "long" | "short"): number {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(TIMEFRAME_WEIGHTS) as TimeframeKey[]) {
    const reading = readings[key];
    if (!reading) continue;
    const weight = TIMEFRAME_WEIGHTS[key];
    weightedSum += weight * legSignal(reading, side);
    weightTotal += weight;
  }
  return weightTotal === 0 ? 0 : clip(weightedSum / weightTotal);
}
