/**
 * v6 -- a complete, self-contained scorer for the trend-pullback-fib buy/
 * sell setup, NOT an ensemble of v1/v2/v3/v5 anymore. Operator spec
 * (2026-08-03), five weighted criteria summing to 100 points, replacing the
 * earlier "average v1/v2/v3/v5's logits plus a binary pattern bonus"
 * design entirely:
 *
 *   1. Correction-leg length        10 pts  (3.3%/bar, capped at 3 bars)
 *   2. Retrace to a RISING 20 EMA   20 pts  (proximity-scaled, 5m prioritized, 15m fallback; 0 if not rising)
 *   3. 40-60% fib retracement       30 pts  (graduated, see scoreFibRetracement)
 *   4. Reversal-bar quality         20 pts  (graduated, see scoreReversalBar)
 *   5. Market speed in setup's favor 20 pts  (points-per-minute, graduated)
 *
 * probability = totalPoints / 100 -- a direct points-to-probability mapping,
 * the same shape v3's own 0-100 core score already uses, not a logit sum.
 *
 * All five criteria reuse strategy/trendPullbackFib.ts's
 * analyzeTrendPullback for the underlying structure (correction leg, trend
 * leg, fib range, trigger level) instead of re-detecting the pattern here
 * -- see that file's header for why sharing one detector matters.
 *
 * The outer consensus rule (engine/loop.ts's hasV6MandatoryAgreement, "v6
 * >= 65% AND at least one of v1/v2/v3/v5 also >= 65%") stays exactly as it
 * was -- that's a separate, external check on top of whatever v6's own
 * number is, kept per operator request (2026-08-03) as an extra guard on a
 * scoring method with zero live trades behind it yet, not something this
 * file needs to know about.
 *
 * Every formula below beyond the operator's own explicit numbers (the fib
 * curve's three anchor points, the EMA's rising requirement, the 0.5/3.0
 * pts-per-minute anchors) is a documented, clearly-flagged interpretation
 * filling a gap the spec didn't pin down numerically -- see each function's
 * own comment for exactly which parts are "operator said this precisely"
 * versus "reasonable interpolation between the two points given."
 */
import type { OhlcBar } from "../regime/indicators.js";
import { ema } from "../analytics/emaTrend.js";
import { atr as computeAtr } from "../regime/indicators.js";
import type { SetupFeatures } from "./features.js";
import type { FactorContribution, ScoreResult } from "./ruleScorer.js";
import { analyzeTrendPullback, isGreen, isRed, type TrendDirection, type CorrectionLeg, type TrendLeg } from "../strategy/trendPullbackFib.js";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ---- #1: correction-leg length (10 pts, 3.3.../bar, capped at 3 bars) ----
// Operator: "three or more red bars or three or more consecutive lower
// highs... valued at 10%, 3.3 per bar." A leg longer than 3 bars still
// caps at the full 10 -- the spec values REACHING three, not exceeding it.
const CORRECTION_BARS_WEIGHT = 10;
const CORRECTION_BARS_CAP = 3;
const CORRECTION_BARS_PER_BAR = CORRECTION_BARS_WEIGHT / CORRECTION_BARS_CAP;

/** direction is analyzeTrendPullback's own read of the 15m EMA slope -- passed in purely to explain a null correctionLeg accurately (was there even a trend to correct against?), not used in the scoring math itself. */
export function scoreCorrectionBars(correctionLeg: CorrectionLeg | null, direction: TrendDirection | null): { points: number; description: string } {
  if (!correctionLeg) {
    const context =
      direction === null
        ? "15m 20 EMA is flat or there aren't enough 15m bars yet -- no trend to measure a correction against"
        : `15m trend is ${direction === "up" ? "rising" : "falling"}, but no clean 3+ bar ${direction === "up" ? "pullback (red bars)" : "bounce (green bars)"} found in the recent 15m bars`;
    return { points: 0, description: `${context} -- 0/${CORRECTION_BARS_WEIGHT} pts` };
  }
  const barCount = correctionLeg.endIndex - correctionLeg.startIndex + 1;
  const creditedBars = Math.min(barCount, CORRECTION_BARS_CAP);
  const points = creditedBars * CORRECTION_BARS_PER_BAR;
  return { points, description: `correction leg is ${barCount} bar(s) (credited ${creditedBars}/${CORRECTION_BARS_CAP}) -- ${points.toFixed(1)}/${CORRECTION_BARS_WEIGHT} pts` };
}

// ---- #2: retrace to a rising 20 EMA (20 pts, proximity-scaled) ----
// Operator: "valued at 20% depending on the proximity of the 20 EMA, the 20
// ma should be rising in price" -- exact proximity CURVE not specified
// (operator: "use a reasonable default"), widened (2026-08-03, operator:
// "v6 needs to use the 5 minute ema and the 15 minute ema too") to check
// BOTH timeframes, then narrowed again the same day (operator: "v6 should
// prioritize the 5 ema"): 5m is now the PRIMARY reference whenever it's
// available -- not "whichever of the two is numerically closer" -- and 15m
// is only a fallback when there isn't enough data for a 5m reading yet.
// This also matches the stop itself, which is placed on the 5m 20 EMA (see
// strategy/trendPullbackFib.ts's computeExplicitStopTarget) -- proximity
// and the stop are now judged against the same EMA reading, not two
// different ones that could disagree. "Rising" stays a single hard
// requirement based on the 15m direction analyzeTrendPullback already
// computed -- the 15m trend is what defines whether this is a valid setup
// at all; a 5-minute EMA's own slope is far noisier and isn't a second,
// independent direction check, just where proximity gets measured once
// direction already qualifies. Proximity curve: the same linear-taper shape
// already established in this codebase (ruleScorerV3.ts's
// EMA_PROXIMITY_ATR_RANGE), full marks at 0 distance, 0 pts at
// EMA20_PROXIMITY_ATR_RANGE or beyond.
//
// scoreSetupV6 passes a.bars5m (2026-08-03) -- strategy/trendPullbackFib.ts's
// genuine, clock-aligned 5-minute aggregate -- not the raw bar stream. Before
// that fix this was silently averaging the last 20 native (1-minute) bars, a
// 20-minute lookback rather than the intended 20x5min=100 minutes. See that
// file's header for the full story.
const EMA20_PROXIMITY_WEIGHT = 20;
const EMA20_PROXIMITY_ATR_RANGE = 2.0;
const EMA_PERIOD = 20;

/** Signed distance from the last close to that period's EMA, in ATR units -- null if there isn't enough data on this bar series. */
function emaDistanceAtr(bars: OhlcBar[], period: number): number | null {
  const closes = bars.map((b) => b.close);
  if (closes.length < period) return null;
  const emaValue = ema(closes, period).at(-1)!;
  const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
  if (atrSeries.length === 0) return null;
  const atrValue = atrSeries.at(-1)!;
  if (atrValue <= 0) return null;
  return (closes.at(-1)! - emaValue) / atrValue;
}

export function scoreEma20Proximity(bars5m: OhlcBar[], bars15m: OhlcBar[], direction: TrendDirection | null, side: "long" | "short"): { points: number; description: string } {
  const wantDirection: TrendDirection = side === "long" ? "up" : "down";
  if (direction !== wantDirection) {
    const actual = direction === null ? "flat (or not enough 15m bars)" : direction === "up" ? "rising" : "falling";
    return { points: 0, description: `15m 20 EMA is ${actual} -- needs to be ${wantDirection === "up" ? "rising" : "falling"} for a ${side} -- 0/${EMA20_PROXIMITY_WEIGHT} pts` };
  }

  const reading5m = emaDistanceAtr(bars5m, EMA_PERIOD);
  const reading15m = emaDistanceAtr(bars15m, EMA_PERIOD);
  const chosen =
    reading5m !== null ? { label: "5m", distance: reading5m } : reading15m !== null ? { label: "15m, 5m unavailable", distance: reading15m } : null;

  if (!chosen) {
    return { points: 0, description: `not enough bars for a 20 EMA reading on either timeframe -- 0/${EMA20_PROXIMITY_WEIGHT} pts` };
  }

  const distanceAtr = Math.abs(chosen.distance);
  const points = clamp01(1 - distanceAtr / EMA20_PROXIMITY_ATR_RANGE) * EMA20_PROXIMITY_WEIGHT;
  return { points, description: `${distanceAtr.toFixed(2)}x ATR from the rising 20 EMA (${chosen.label}) -- ${points.toFixed(1)}/${EMA20_PROXIMITY_WEIGHT} pts` };
}

// ---- #3: 40-60% fib retracement (30 pts, graduated) ----
// Operator's exact anchor points: >60% retracement = 0 pts. 59% = 100% of
// 30 (30 pts). 39% = 10% of 30 (3 pts). Below 39%, flat at 5% of 30 (1.5
// pts) -- operator's explicit answer when asked what happens below the
// ramp, confirmed as a genuine step (not a smooth continuation) from the
// flat 1.5 floor up to 3 pts right at the 39% line. 59%-60% holds flat at
// the 30-pt ceiling rather than extrapolating past it.
const FIB_WEIGHT = 30;
const FIB_RAMP_START_PCT = 39;
const FIB_RAMP_END_PCT = 59;
const FIB_CUTOFF_PCT = 60;
const FIB_BELOW_RAMP_POINTS = FIB_WEIGHT * 0.05; // flat floor, operator-specified
const FIB_RAMP_START_POINTS = FIB_WEIGHT * 0.1; // operator-specified anchor at 39%
const FIB_RAMP_END_POINTS = FIB_WEIGHT; // operator-specified anchor at 59%

/** correctionLeg/trendLeg are passed in purely to explain a null retracementPct accurately -- which specific prerequisite is missing -- not used in the scoring math itself. */
export function scoreFibRetracement(retracementPct: number | null, correctionLeg: CorrectionLeg | null, trendLeg: TrendLeg | null): { points: number; description: string } {
  if (retracementPct === null) {
    const reason = !correctionLeg
      ? "no correction leg found yet (see correction-leg factor above) -- nothing to measure a retracement against"
      : !trendLeg
        ? "correction leg found, but no valid trend leg precedes it within the lookback window"
        : "trend leg has no measurable price range";
    return { points: 0, description: `${reason} -- 0/${FIB_WEIGHT} pts` };
  }
  if (retracementPct > FIB_CUTOFF_PCT) return { points: 0, description: `${retracementPct.toFixed(0)}% retracement -- over the ${FIB_CUTOFF_PCT}% cutoff -- 0/${FIB_WEIGHT} pts` };
  if (retracementPct < FIB_RAMP_START_PCT) return { points: FIB_BELOW_RAMP_POINTS, description: `${retracementPct.toFixed(0)}% retracement -- below the ${FIB_RAMP_START_PCT}% ramp, flat floor -- ${FIB_BELOW_RAMP_POINTS.toFixed(1)}/${FIB_WEIGHT} pts` };
  const clampedPct = Math.min(retracementPct, FIB_RAMP_END_PCT);
  const fraction = (clampedPct - FIB_RAMP_START_PCT) / (FIB_RAMP_END_PCT - FIB_RAMP_START_PCT);
  const points = FIB_RAMP_START_POINTS + fraction * (FIB_RAMP_END_POINTS - FIB_RAMP_START_POINTS);
  return { points, description: `${retracementPct.toFixed(0)}% retracement -- ${points.toFixed(1)}/${FIB_WEIGHT} pts` };
}

// ---- #4: reversal-bar quality (20 pts, graduated) ----
// Operator: "a green bar forming from the previous 3+ red bars, it closes
// above the previous red's high OR closes green -- 1% being a green flat
// bar, 20% being closing above the previous red's high." The interpolation
// IN BETWEEN those two endpoints isn't operator-specified -- this measures
// how far the trigger bar's close has progressed from the correction leg's
// own last close (0% progress -- still sitting where the correction left
// off) to the trigger level (100% progress -- the same break the strategy's
// own hard trigger requires), and maps that progress onto the 1-20 range. A
// bar that isn't even green scores 0, not the 1-point floor -- "green flat
// bar" is described as the MINIMUM case for a bar that qualifies at all.
const REVERSAL_BAR_WEIGHT = 20;
const REVERSAL_BAR_FLOOR_POINTS = 1;

export function scoreReversalBar(bars5m: OhlcBar[], correctionEndBar15m: OhlcBar | null, triggerLevel: number | null, side: "long" | "short"): { points: number; description: string } {
  if (!correctionEndBar15m || triggerLevel === null) return { points: 0, description: `no correction leg to measure a reversal bar against -- 0/${REVERSAL_BAR_WEIGHT} pts` };
  const lastBar5m = bars5m.at(-1);
  if (!lastBar5m) return { points: 0, description: `no bars -- 0/${REVERSAL_BAR_WEIGHT} pts` };

  const qualifies = side === "long" ? isGreen(lastBar5m) : isRed(lastBar5m);
  if (!qualifies) {
    return { points: 0, description: `most recent 5m bar isn't ${side === "long" ? "green" : "red"} -- 0/${REVERSAL_BAR_WEIGHT} pts` };
  }

  const zero = correctionEndBar15m.close;
  const target = triggerLevel;
  const range = side === "long" ? target - zero : zero - target;
  const rawProgress = range > 0 ? (side === "long" ? (lastBar5m.close - zero) / range : (zero - lastBar5m.close) / range) : 0;
  const progress = clamp01(rawProgress);
  const points = REVERSAL_BAR_FLOOR_POINTS + progress * (REVERSAL_BAR_WEIGHT - REVERSAL_BAR_FLOOR_POINTS);
  return { points, description: `${side === "long" ? "green" : "red"} reversal bar, ${(progress * 100).toFixed(0)}% of the way to breaking the correction's level -- ${points.toFixed(1)}/${REVERSAL_BAR_WEIGHT} pts` };
}

// ---- #5: market speed in the setup's favor (20 pts, graduated) ----
// Operator: "buy volume spikes... 0.5 in favor being 1%, 3pts or more being
// the full 20%" -- clarified to mean features.netPointsPerMinute (this
// system's existing "market speed" signal, analytics/ppm.ts), not raw
// order-flow volume. Below the 0.5 floor (including speed against the
// setup) scores 0 -- not operator-specified, but treated differently from
// fib's flat floor since "market isn't helping at all" is a different kind
// of case than "close-ish to the ideal retracement zone."
const PPM_WEIGHT = 20;
const PPM_FLOOR = 0.5;
const PPM_CEIL = 3.0;
const PPM_FLOOR_POINTS = 1;

export function scoreMarketSpeed(netPointsPerMinute: number | null, side: "long" | "short"): { points: number; description: string } {
  if (netPointsPerMinute === null) return { points: 0, description: `no points-per-minute reading -- 0/${PPM_WEIGHT} pts` };
  const favorable = side === "long" ? netPointsPerMinute : -netPointsPerMinute;
  if (favorable < PPM_FLOOR) {
    return { points: 0, description: `market speed ${favorable.toFixed(2)} pts/min in ${side}'s favor -- below the ${PPM_FLOOR} floor -- 0/${PPM_WEIGHT} pts` };
  }
  const clamped = Math.min(favorable, PPM_CEIL);
  const fraction = (clamped - PPM_FLOOR) / (PPM_CEIL - PPM_FLOOR);
  const points = PPM_FLOOR_POINTS + fraction * (PPM_WEIGHT - PPM_FLOOR_POINTS);
  return { points, description: `market speed ${favorable.toFixed(2)} pts/min in ${side}'s favor -- ${points.toFixed(1)}/${PPM_WEIGHT} pts` };
}

export function scoreSetupV6(features: SetupFeatures, bars: OhlcBar[]): ScoreResult {
  const a = analyzeTrendPullback(bars);
  const factors: FactorContribution[] = [];

  const correctionBars = scoreCorrectionBars(a.correctionLeg, a.direction);
  factors.push({ name: "correctionLegBars", contribution: correctionBars.points, description: correctionBars.description });

  const emaProximity = scoreEma20Proximity(a.bars5m, a.bars15m, a.direction, features.side);
  factors.push({ name: "rising20EmaProximity", contribution: emaProximity.points, description: emaProximity.description });

  const fib = scoreFibRetracement(a.retracementPct, a.correctionLeg, a.trendLeg);
  factors.push({ name: "fibRetracement", contribution: fib.points, description: fib.description });

  const correctionEndBar15m = a.correctionLeg ? a.bars15m[a.correctionLeg.endIndex]! : null;
  const reversalBar = scoreReversalBar(bars, correctionEndBar15m, a.triggerLevel, features.side);
  factors.push({ name: "reversalBarQuality", contribution: reversalBar.points, description: reversalBar.description });

  const marketSpeed = scoreMarketSpeed(features.netPointsPerMinute, features.side);
  factors.push({ name: "marketSpeed", contribution: marketSpeed.points, description: marketSpeed.description });

  const totalPoints = correctionBars.points + emaProximity.points + fib.points + reversalBar.points + marketSpeed.points;
  const probability = totalPoints / 100;

  return { probability, factors };
}
