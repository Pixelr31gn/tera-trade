/**
 * v3 rule-based scorer -- rebuilt to the exact spec provided: six
 * independent factors combined into a 0-100 "Probability Confidence Score",
 * evaluated for BOTH the bullish and bearish hypothesis on every bar (not
 * just whichever side a strategy happened to propose), so a setup only ever
 * gets taken when there's real directional conviction -- not just one side
 * clearing a threshold while the other is nearly as strong.
 *
 * Factors (must sum to 100):
 *   1. Trend direction (EMA50 + slope)           20 pts
 *   2. Trend strength (ADX, magnitude-only)       20 pts
 *   3. Volatility (ATR vs. its own recent average) 15 pts
 *   4. Volume confirmation (bar volume vs 20-bar avg) 15 pts
 *   5. RSI momentum confirmation (never a standalone signal) 10 pts
 *   6. Price structure (HH/HL vs LH/LL)           20 pts
 *
 * A historical-similarity adjustment (comparing against the last 5-15
 * resolved v3 setups with matching conditions) is applied separately, in
 * scoring/v3HistoricalAdjustment.ts, since it needs a DB round-trip this
 * module deliberately stays free of -- everything here is a pure function
 * of the bars/features passed in.
 */
import type { OhlcBar } from "../regime/indicators.js";
import { atr } from "../regime/indicators.js";
import { classifyEma50Trend, type Ema50Trend } from "../analytics/emaTrend.js";
import { lastRsi } from "../analytics/rsi.js";
import type { MarketStructureLabel } from "../analytics/priceAction.js";
import { fibDirectionSignal } from "../analytics/fibonacci.js";
import { ppmDirectionSignal } from "../analytics/ppm.js";
import { orderFlowDirectionSignal } from "../analytics/orderFlow.js";
import { timeframeAlignmentSignal, type TimeframeTrendReadings } from "../analytics/timeframeAlignment.js";
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";
import type { SetupFeatures } from "./features.js";

export interface V3FactorContribution {
  name: string;
  points: number;
  maxPoints: number;
  description: string;
}

export interface V3SideScore {
  score: number; // 0-100
  factors: V3FactorContribution[];
}

export interface V3AbsoluteReadings {
  emaTrend: Ema50Trend;
  adx: number | null;
  atrRatio: number | null; // current ATR / recent average ATR
  volumeRatio: number | null; // current bar volume / 20-bar average volume
  rsi: number | null;
  marketStructureLabel: MarketStructureLabel;
}

export interface V3DirectionalResult {
  readings: V3AbsoluteReadings;
  bullish: V3SideScore;
  bearish: V3SideScore;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Piecewise-linear interpolation through hand-set (x, y) anchor points -- smooths what the spec describes as discrete zones/tiers into a continuous score. */
function interpolate(x: number, points: [number, number][]): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return points.at(-1)![1];
}

const ATR_AVERAGE_LOOKBACK = 20;
const VOLUME_AVERAGE_LOOKBACK = 20;

export function computeAbsoluteReadings(bars: OhlcBar[], features: SetupFeatures): V3AbsoluteReadings {
  const emaTrend = classifyEma50Trend(bars);
  const rsi = lastRsi(bars);

  const atrSeries = atr(bars).filter((v) => !Number.isNaN(v));
  let atrRatio: number | null = null;
  if (atrSeries.length >= ATR_AVERAGE_LOOKBACK + 1) {
    const current = atrSeries.at(-1)!;
    const avg = mean(atrSeries.slice(-ATR_AVERAGE_LOOKBACK));
    atrRatio = avg > 0 ? current / avg : null;
  }

  let volumeRatio: number | null = null;
  if (bars.length >= VOLUME_AVERAGE_LOOKBACK + 1) {
    const volumes = bars.map((b) => b.volume);
    const current = volumes.at(-1)!;
    const avg = mean(volumes.slice(-VOLUME_AVERAGE_LOOKBACK - 1, -1));
    volumeRatio = avg > 0 ? current / avg : null;
  }

  return { emaTrend, adx: features.adx, atrRatio, volumeRatio, rsi, marketStructureLabel: features.marketStructureLabel };
}

// 1. Trend direction (EMA50 + slope) -- 20 pts
function scoreEmaTrend(emaTrend: Ema50Trend, side: "long" | "short"): V3FactorContribution {
  const max = 20;
  if (emaTrend.label === "neutral" || emaTrend.slope === null) {
    return { name: "trendDirection", points: 8, maxPoints: max, description: "EMA50 is flat / price is moving sideways -- no clear trend" };
  }

  const aligned = (emaTrend.label === "bullish" && side === "long") || (emaTrend.label === "bearish" && side === "short");
  // Slope magnitude scaled against a hand-set reference (0.002 normalized
  // change over the lookback is already a meaningful intraday EMA50 move
  // for these instruments) -- same "documented prior, not fitted" approach
  // used throughout the rest of the scorer.
  const magnitude = clip(Math.abs(emaTrend.slope) / 0.002, 0, 1);
  const points = aligned ? 12 + 8 * magnitude : 8 - 8 * magnitude;
  return {
    name: "trendDirection",
    points,
    maxPoints: max,
    description: `EMA50 trend is ${emaTrend.label}, ${aligned ? "agrees with" : "opposes"} a ${side} setup`,
  };
}

// 2. Trend strength (ADX) -- 20 pts, magnitude only, independent of direction
const ADX_POINTS: [number, number][] = [
  [0, 2],
  [20, 8],
  [25, 13],
  [40, 18],
  [60, 20],
];
function scoreAdx(adxValue: number | null): V3FactorContribution {
  const max = 20;
  if (adxValue === null) return { name: "trendStrength", points: 8, maxPoints: max, description: "no ADX reading yet" };
  const points = interpolate(adxValue, ADX_POINTS);
  const tier = adxValue < 20 ? "weak (likely ranging)" : adxValue < 25 ? "developing" : adxValue < 40 ? "strong" : "very strong";
  return { name: "trendStrength", points, maxPoints: max, description: `ADX=${adxValue.toFixed(1)} -- ${tier} trend` };
}

// 3. Volatility (ATR vs. its own recent average) -- 15 pts
function scoreAtr(atrRatio: number | null): V3FactorContribution {
  const max = 15;
  if (atrRatio === null) return { name: "volatility", points: 7.5, maxPoints: max, description: "not enough bars yet for an ATR average" };
  const points = clip(7.5 + (atrRatio - 1) * 7.5, 0, max);
  return { name: "volatility", points, maxPoints: max, description: `ATR is ${(atrRatio * 100).toFixed(0)}% of its ${ATR_AVERAGE_LOOKBACK}-bar average` };
}

// 4. Volume confirmation (bar volume vs 20-bar average) -- 15 pts
function scoreVolume(volumeRatio: number | null): V3FactorContribution {
  const max = 15;
  if (volumeRatio === null) return { name: "volumeConfirmation", points: 7.5, maxPoints: max, description: "not enough bars yet for a volume average" };
  const points = clip(7.5 + (volumeRatio - 1) * 7.5, 0, max);
  return { name: "volumeConfirmation", points, maxPoints: max, description: `volume is ${(volumeRatio * 100).toFixed(0)}% of its ${VOLUME_AVERAGE_LOOKBACK}-bar average` };
}

// 5. RSI momentum confirmation -- 10 pts, never a standalone signal
const RSI_LONG_POINTS: [number, number][] = [
  [0, 1],
  [45, 2],
  [55, 5],
  [65, 10],
  [70, 10],
  [75, 7],
  [85, 3],
  [100, 1],
];
const RSI_SHORT_POINTS: [number, number][] = [
  [0, 1],
  [15, 3],
  [25, 7],
  [30, 10],
  [35, 10],
  [45, 5],
  [55, 2],
  [100, 1],
];
function scoreRsi(rsiValue: number | null, side: "long" | "short"): V3FactorContribution {
  const max = 10;
  if (rsiValue === null) return { name: "rsiMomentum", points: 4, maxPoints: max, description: "not enough bars yet for RSI" };
  const points = interpolate(rsiValue, side === "long" ? RSI_LONG_POINTS : RSI_SHORT_POINTS);
  return { name: "rsiMomentum", points, maxPoints: max, description: `RSI=${rsiValue.toFixed(0)} ${points >= 8 ? "confirms strong" : points <= 3 ? "does not support" : "gives modest"} ${side} momentum` };
}

// 6. Price structure (HH/HL vs LH/LL) -- 20 pts
function scoreStructure(label: MarketStructureLabel, side: "long" | "short"): V3FactorContribution {
  const max = 20;
  if (label === "ranging") {
    return { name: "priceStructure", points: 5, maxPoints: max, description: "no clear higher-high/higher-low or lower-high/lower-low structure -- ranging" };
  }
  const strong = label === "strong_uptrend" || label === "strong_downtrend";
  const aligned = (label === "strong_uptrend" && side === "long") || (label === "strong_downtrend" && side === "short") || (label === "weak_uptrend" && side === "long") || (label === "weak_downtrend" && side === "short");
  const points = aligned ? (strong ? 20 : 13) : strong ? 2 : 6;
  return { name: "priceStructure", points, maxPoints: max, description: `market structure (${label}) ${aligned ? "agrees with" : "opposes"} a ${side} setup` };
}

function scoreForSide(readings: V3AbsoluteReadings, side: "long" | "short"): V3SideScore {
  const factors = [
    scoreEmaTrend(readings.emaTrend, side),
    scoreAdx(readings.adx),
    scoreAtr(readings.atrRatio),
    scoreVolume(readings.volumeRatio),
    scoreRsi(readings.rsi, side),
    scoreStructure(readings.marketStructureLabel, side),
  ];
  const score = clip(factors.reduce((sum, f) => sum + f.points, 0), 0, 100);
  return { score: Math.round(score * 100) / 100, factors };
}

export function scoreSetupV3Directional(bars: OhlcBar[], features: SetupFeatures): V3DirectionalResult {
  const readings = computeAbsoluteReadings(bars, features);
  return {
    readings,
    bullish: scoreForSide(readings, "long"),
    bearish: scoreForSide(readings, "short"),
  };
}

export interface BreakoutStrengthResult {
  adjustmentPoints: number;
  closeLocationValue: number; // 0 (closed at the bar's low) -> 1 (closed at the bar's high), unmirrored
  description: string;
}

// Breakout conviction adjustment -- NOT one of the six core factors above
// (those stay fixed at 100 pts total, per the documented spec); a separate,
// bounded additive nudge applied only to breakout-kind signals (see
// strategy/types.ts's Signal.signalKind), based on where the breakout bar
// closed within its own high/low range. A close near the extreme in the
// breakout's favor (near the high for a long, near the low for a short)
// shows real conviction behind the move; a close that's already drifted
// back toward the middle or opposite side is the classic shape of a
// breakout about to fail. This is legitimate and instantly computable at
// signal time from the bar that already closed -- unlike waiting for
// follow-through on a future bar, which would delay entry and give up the
// cheapest part of a genuine move (see the risk/reward discussion this was
// built from). Bounded smaller than the historical-similarity adjustment
// (+/-15) since this is a documented heuristic, not yet validated against
// real outcomes the way that one is.
const MAX_BREAKOUT_STRENGTH_ADJUSTMENT = 10;

export function computeBreakoutStrengthAdjustment(lastBar: OhlcBar, side: "long" | "short"): BreakoutStrengthResult {
  const range = lastBar.high - lastBar.low;
  if (range <= 0) {
    return { adjustmentPoints: 0, closeLocationValue: 0.5, description: "breakout bar has zero range -- no conviction signal available" };
  }
  const closeLocationValue = (lastBar.close - lastBar.low) / range;
  // Mirror for side so "strength" always runs 0 (weak) -> 1 (strong): a long
  // wants the close near the high (clv->1), a short wants it near the low (clv->0).
  const strength = side === "long" ? closeLocationValue : 1 - closeLocationValue;
  const adjustmentPoints = (strength - 0.5) * 2 * MAX_BREAKOUT_STRENGTH_ADJUSTMENT;
  const tier = strength >= 0.7 ? "closed strong, near the breakout extreme" : strength <= 0.3 ? "closed weak, already drifting back from the extreme" : "closed mid-range, no strong signal either way";
  return {
    adjustmentPoints,
    closeLocationValue,
    description: `breakout bar ${tier} (${(strength * 100).toFixed(0)}% conviction) -- ${adjustmentPoints >= 0 ? "+" : ""}${adjustmentPoints.toFixed(1)} pt adjustment`,
  };
}

export interface RiskRewardAdjustmentResult {
  adjustmentPoints: number;
  description: string;
}

// Separate, bounded additive adjustment -- NOT one of the six core 100-pt
// factors (same reasoning as computeBreakoutStrengthAdjustment above: the
// documented spec's six factors stay fixed). Centered on the 1:3 floor
// already enforced at execution time (risk/tradePlan.ts) -- neutral exactly
// at the floor, rewarded above it, penalized below (before that floor would
// widen the stop). Same +/-10 bound as the breakout-strength adjustment,
// since this is also a documented heuristic rather than one validated
// against real outcomes yet.
const RISK_REWARD_FLOOR = 3;
const RISK_REWARD_SPAN = 3;
const MAX_RISK_REWARD_ADJUSTMENT = 10;

export function computeRiskRewardAdjustment(riskRewardRatio: number | null | undefined): RiskRewardAdjustmentResult {
  if (riskRewardRatio == null) {
    return { adjustmentPoints: 0, description: "no stop plan available yet -- no risk/reward adjustment" };
  }
  const raw = clip((riskRewardRatio - RISK_REWARD_FLOOR) / RISK_REWARD_SPAN, -1, 1);
  const adjustmentPoints = raw * MAX_RISK_REWARD_ADJUSTMENT;
  return {
    adjustmentPoints,
    description: `hypothetical reward:risk is ${riskRewardRatio.toFixed(2)}:1 (vs the ${RISK_REWARD_FLOOR}:1 floor) -- ${adjustmentPoints >= 0 ? "+" : ""}${adjustmentPoints.toFixed(1)} pt adjustment`,
  };
}

export interface DirectionAdjustmentResult {
  adjustmentPoints: number;
  description: string;
}

// Same bounded-adjustment pattern as computeRiskRewardAdjustment above --
// not one of the six core 100-pt factors. See analytics/fibonacci.ts's
// fibDirectionSignal for the underlying -1..1 scale (shared with v1/v2).
const MAX_FIB_ADJUSTMENT = 8;

export function computeFibAdjustment(swingDirection: "up" | "down" | null | undefined, retracementPct: number | null | undefined, side: "long" | "short"): DirectionAdjustmentResult {
  const raw = fibDirectionSignal(swingDirection ?? null, retracementPct ?? null, side);
  const adjustmentPoints = raw * MAX_FIB_ADJUSTMENT;
  const pct = retracementPct != null ? `${(retracementPct * 100).toFixed(0)}% retracement` : "no retracement reading";
  return {
    adjustmentPoints,
    description: swingDirection
      ? `${swingDirection} swing, ${pct} -- ${adjustmentPoints >= 0 ? "+" : ""}${adjustmentPoints.toFixed(1)} pt adjustment`
      : "not enough bars for a swing reading -- no adjustment",
  };
}

// ~10% of the 100-pt core score (2026-07-15, operator request). See
// analytics/ppm.ts's ppmDirectionSignal for the underlying -1..1 scale
// (shared with v1/v2).
const MAX_PPM_ADJUSTMENT = 10;

export function computePpmAdjustment(netPointsPerMinute: number | null | undefined, side: "long" | "short"): DirectionAdjustmentResult {
  const raw = ppmDirectionSignal(netPointsPerMinute ?? null, side);
  const adjustmentPoints = raw * MAX_PPM_ADJUSTMENT;
  return {
    adjustmentPoints,
    description:
      netPointsPerMinute != null
        ? `market moving ${netPointsPerMinute >= 0 ? "up" : "down"} at ${Math.abs(netPointsPerMinute).toFixed(2)} pts/min -- ${adjustmentPoints >= 0 ? "+" : ""}${adjustmentPoints.toFixed(1)} pt adjustment`
        : "not enough recent ticks for a points-per-minute reading -- no adjustment",
  };
}

// Same bounded-adjustment pattern as computeFibAdjustment/computePpmAdjustment
// above -- not one of the six core 100-pt factors. Live order flow is only
// available when PRICE_SOURCE=browser and ORDER_FLOW_ENABLED=true (see
// core/config.ts); a null snapshot (feature disabled, or no snapshot yet for
// this symbol) draws no adjustment rather than a fabricated neutral one.
const MAX_ORDER_FLOW_ADJUSTMENT = 8;

export function computeOrderFlowAdjustment(snapshot: OrderFlowSnapshot | null, side: "long" | "short"): DirectionAdjustmentResult {
  if (!snapshot) {
    return { adjustmentPoints: 0, description: "no live order-flow snapshot available -- no adjustment" };
  }
  const raw = orderFlowDirectionSignal(snapshot, side);
  const adjustmentPoints = raw * MAX_ORDER_FLOW_ADJUSTMENT;
  return {
    adjustmentPoints,
    description: `order flow: ${snapshot.buyVolume.toFixed(0)} buy / ${snapshot.sellVolume.toFixed(0)} sell vol (${snapshot.tradeCount} trades), bid ${snapshot.bestBidSize ?? "?"} / ask ${snapshot.bestAskSize ?? "?"} -- ${adjustmentPoints >= 0 ? "+" : ""}${adjustmentPoints.toFixed(1)} pt adjustment`,
  };
}

// Same bounded-adjustment pattern as computeFibAdjustment/computePpmAdjustment
// above -- not one of the six core 100-pt factors. See
// analytics/timeframeAlignment.ts's timeframeAlignmentSignal for the -1..1
// scale, combining up to 7 timeframes weighted so higher ones count more.
// Bounded wider than the single-input adjustments (fib +/-8, ppm/order-flow
// +/-10/+/-8) since this is already a weighted combination of multiple
// independent reads, but still below the historical-similarity adjustment's
// +/-15, since -- like the rest of the adjustments here -- it isn't yet
// validated against real resolved-outcome data the way that one is.
const MAX_TIMEFRAME_ALIGNMENT_ADJUSTMENT = 12;

export function computeTimeframeAlignmentAdjustment(readings: TimeframeTrendReadings, side: "long" | "short"): DirectionAdjustmentResult {
  const raw = timeframeAlignmentSignal(readings, side);
  const adjustmentPoints = raw * MAX_TIMEFRAME_ALIGNMENT_ADJUSTMENT;
  const available = Object.keys(readings).length;
  return {
    adjustmentPoints,
    description:
      available > 0
        ? `multi-timeframe alignment across ${available}/7 available timeframes -- ${adjustmentPoints >= 0 ? "+" : ""}${adjustmentPoints.toFixed(1)} pt adjustment`
        : "no timeframe reads available yet -- no adjustment",
  };
}

// A coarse categorical fingerprint of "current market conditions", used to
// find recently-resolved v3 setups that looked similar -- see
// scoring/v3HistoricalAdjustment.ts. Deliberately coarse (a handful of
// buckets per factor) so there's a realistic chance of finding 5-15 matches
// at all; a continuous-feature nearest-neighbor search would rarely find
// exact matches with the data volume this system has.
export function computeV3Bucket(readings: V3AbsoluteReadings, side: "long" | "short"): string {
  const adxTier = readings.adx === null ? "na" : readings.adx < 20 ? "weak" : readings.adx < 25 ? "developing" : readings.adx < 40 ? "strong" : "vstrong";
  const atrTier = readings.atrRatio === null ? "na" : readings.atrRatio >= 1 ? "above" : "below";
  const volTier = readings.volumeRatio === null ? "na" : readings.volumeRatio >= 1 ? "above" : "below";
  const rsiTier = readings.rsi === null ? "na" : readings.rsi < 30 ? "low" : readings.rsi < 45 ? "lowmid" : readings.rsi < 55 ? "mid" : readings.rsi < 70 ? "highmid" : "high";
  return [side, readings.emaTrend.label, adxTier, atrTier, volTier, rsiTier, readings.marketStructureLabel].join(":");
}
