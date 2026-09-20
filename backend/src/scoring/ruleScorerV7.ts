/**
 * v7 -- a complete, self-contained scorer built from Step -1 of the
 * `add-scoring-version` skill's pattern-mining methodology (2026-08-07):
 * queried win rate by side across every SetupFeatures dimension against
 * 159,948 real scored setups (305 executed, ~110k retrospectively-simulated
 * "missed" outcomes -- see engine/outcomeEvaluator.ts), requiring n>200 per
 * bucket, same as the queries that built v5/v6 (see BUILD_HISTORY.md).
 * Baseline win rate across all scored setups is ~29%.
 *
 * Three real, sample-rich, side-asymmetric patterns survived that screen:
 *
 *   1. MA20-distance mean reversion (see scoreMaDistanceAsymmetry) --
 *      shorts do best moderately ABOVE the 20-MA (0-1 ATR: 37.4%, n=10,013),
 *      worst far BELOW it (25.8%, n=19,843). Longs invert: best far BELOW
 *      (31.8%, n=16,647), worst moderately ABOVE (24.2%, n=11,922). Not a
 *      simple "fade the extension" rule -- it's conditional on side in a way
 *      that only shows up by splitting the query on side.
 *   2. ADX>=40 regime asymmetry (see scoreAdxRegimeAsymmetry) -- confirms
 *      the same-direction pattern BUILD_HISTORY.md documents for v5 (very
 *      strong trend favors shorts) is still real on this larger dataset,
 *      though the magnitude has narrowed (36.6% vs 28.2% now, was 54.8% vs
 *      19.7% when v5 was built) -- expected as more data accumulates and
 *      the effect partially self-corrects once versions already act on it.
 *      Monotonic for shorts (25.8% -> 30.2% -> 30.8% -> 36.6% as ADX rises
 *      through its four buckets); much flatter for longs (27.3%-29.5%
 *      across all four), so the long-side contribution here is
 *      deliberately muted relative to the short side, not symmetric.
 *   3. Short-term momentum "grind" pattern (see scoreMomentumGrind) --
 *      counter-intuitive: mildly FAVORABLE momentum (0 to 5 pts/min) beats
 *      strongly favorable, and mildly UNFAVORABLE momentum is the single
 *      worst bucket found in the whole pass (long+slow_down: 23.8%,
 *      short+slow_up: 24.6%) -- worse than being strongly fought (~29-30%
 *      either side). Read literally rather than smoothed into a monotonic
 *      curve that isn't actually in the data -- see that function's own
 *      comment for the real shape.
 *
 * probability = totalPoints / 100, same direct mapping v6 uses -- not a
 * logit sum. Both sides can reach the full 100 points (see
 * scoreAdxRegimeAsymmetry's 2026-08-17 note): the ADX factor's long-side
 * weight was originally half the short-side weight (15 vs 30) to reflect
 * that the mined evidence was much weaker for longs on that one factor, but
 * since the final probability is just total points / 100 regardless of
 * side, that gave longs a hard 85-point ceiling no long setup could ever
 * cross -- a structural bias favoring shorts on every score, not merely a
 * reflection of the underlying win-rate data it was meant to document.
 * Equalized 2026-08-17 (operator request) -- the shape of each side's curve
 * is unchanged (short stays a monotonic ramp across the ADX range; long
 * stays a flat bonus below a threshold, zero above), only the ceiling both
 * can reach.
 *
 * Zero live trades behind this version's own weight yet (same
 * caveat as v5/v6 at their own introduction) -- shadow-scored only, see
 * engine/loop.ts's SHADOW_ONLY_VERSIONS, until real outcomes justify
 * promotion. Re-run the Step -1 queries periodically: these numbers will
 * drift as more data accumulates and as any version that already acts on
 * an overlapping factor (v5's ADX read, in particular) pulls its own edge
 * toward zero over time.
 */
import type { SetupFeatures } from "./features.js";
import type { FactorContribution, ScoreResult } from "./ruleScorer.js";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ---- #1: MA20-distance mean reversion (40 pts) ----
// Discrete buckets tied directly to the four measured ranges, not a smoothed
// curve -- the long-side data is non-monotonic across distance (far_below
// 31.8% > far_above 28.3% > below 25.9% > above 24.2%), so fitting a single
// linear ramp would misrepresent buckets the data doesn't actually support.
// Points below are each bucket's real win rate scaled relative to the
// ~29% baseline and the 0-40 range, per side, not a formula -- see the file
// header for the underlying query and exact percentages/sample sizes.
const MA_DISTANCE_WEIGHT = 40;

export function scoreMaDistanceAsymmetry(distanceFromMa20Atr: number | null, side: "long" | "short"): { points: number; description: string } {
  if (distanceFromMa20Atr === null) {
    return { points: 0, description: `no 20-MA distance reading -- 0/${MA_DISTANCE_WEIGHT} pts` };
  }
  const d = distanceFromMa20Atr;
  let bucket: "far_below" | "below" | "above" | "far_above";
  if (d <= -1) bucket = "far_below";
  else if (d < 0) bucket = "below";
  else if (d < 1) bucket = "above";
  else bucket = "far_above";

  const pointsBySide: Record<"long" | "short", Record<typeof bucket, number>> = {
    long: { far_below: 40, below: 10, above: 0, far_above: 20 },
    short: { far_below: 0, below: 10, above: 40, far_above: 30 },
  };
  const points = pointsBySide[side][bucket];
  const label = bucket.replace("_", " ");
  return { points, description: `${d.toFixed(2)}x ATR from the 20-MA (${label}) -- ${points}/${MA_DISTANCE_WEIGHT} pts` };
}

// ---- #2: ADX>=40 regime asymmetry (30 pts) ----
// Monotonic and strong for shorts (see file header); flat and weak for
// longs. Weights equalized 2026-08-17 (operator request, see file header) --
// long's weight was previously capped at half the short side's (15 vs 30) to
// reflect that the evidence backing it is much thinner, but that gave every
// long setup a hard sub-100 ceiling on this model regardless of the actual
// setup, a structural bias rather than a data-driven one. The underlying
// asymmetry in the evidence is still real and still reflected in each side's
// curve *shape* below (short ramps monotonically with ADX; long gets only a
// flat, capped bonus for a weak/developing trend) -- only the two ceilings
// are now equal.
const ADX_REGIME_WEIGHT_SHORT = 30;
const ADX_REGIME_WEIGHT_LONG = 30;

export function scoreAdxRegimeAsymmetry(adx: number | null, side: "long" | "short"): { points: number; description: string } {
  if (adx === null) {
    const weight = side === "short" ? ADX_REGIME_WEIGHT_SHORT : ADX_REGIME_WEIGHT_LONG;
    return { points: 0, description: `no ADX reading -- 0/${weight} pts` };
  }
  if (side === "short") {
    // Real measured win rates by bucket: <15 25.8%, 15-25 30.2%, 25-40
    // 30.8%, 40+ 36.6% -- fraction-of-range scaling between the worst and
    // best bucket, not a hand-picked curve.
    const fraction = clamp01((adx - 15) / (40 - 15));
    const points = fraction * ADX_REGIME_WEIGHT_SHORT;
    return { points, description: `ADX=${adx.toFixed(1)} -- shorts historically improve as trend strengthens (25.8% at <15 up to 36.6% at 40+) -- ${points.toFixed(1)}/${ADX_REGIME_WEIGHT_SHORT} pts` };
  }
  // Long side: weak/developing trend (27.3%-29.5%) mildly outperforms
  // strong/very-strong (27.3%-28.2%) -- muted, roughly-flat reward for
  // ADX < 25 rather than the sharp monotonic ramp the short side gets.
  const points = adx < 25 ? ADX_REGIME_WEIGHT_LONG : 0;
  return { points, description: `ADX=${adx.toFixed(1)} -- longs show a weak, mostly-flat edge for a weak/developing (<25) trend -- ${points}/${ADX_REGIME_WEIGHT_LONG} pts` };
}

// ---- #3: short-term momentum "grind" pattern (30 pts) ----
// Counter-intuitive and read literally from the data, not smoothed into a
// monotonic story: mildly FAVORABLE momentum (0 to 5 pts/min) is the best
// bucket for both sides (long+slow_up 31.2%, short+slow_down 32.5%);
// mildly UNFAVORABLE momentum (0 to -5 against) is the single worst bucket
// found in the whole pass (long+slow_down 23.8%, short+slow_up 24.6%) --
// worse than being strongly fought by fast momentum in either direction
// (~28-31% for both "fast_down"/"fast_up" buckets regardless of side). The
// mild-against zone is penalized hard; strong momentum either way (aligned
// or against) gets a middling, roughly-flat score.
const MOMENTUM_WEIGHT = 30;
const MOMENTUM_MILD_AGAINST_POINTS = 3;
const MOMENTUM_STRONG_EITHER_WAY_POINTS = 20;

export function scoreMomentumGrind(netPointsPerMinute: number | null, side: "long" | "short"): { points: number; description: string } {
  if (netPointsPerMinute === null) {
    return { points: 0, description: `no points-per-minute reading -- 0/${MOMENTUM_WEIGHT} pts` };
  }
  const favorable = side === "long" ? netPointsPerMinute : -netPointsPerMinute;

  if (favorable >= 0 && favorable < 5) {
    // Mildly favorable -- the best bucket found for either side.
    return { points: MOMENTUM_WEIGHT, description: `market speed ${favorable.toFixed(2)} pts/min mildly in ${side}'s favor -- the strongest bucket found for either side -- ${MOMENTUM_WEIGHT}/${MOMENTUM_WEIGHT} pts` };
  }
  if (favorable < 0 && favorable >= -5) {
    // Mildly against -- the single worst bucket found in the whole pass.
    return { points: MOMENTUM_MILD_AGAINST_POINTS, description: `market speed ${favorable.toFixed(2)} pts/min mildly against ${side} -- the weakest bucket found in the whole pattern-mining pass -- ${MOMENTUM_MILD_AGAINST_POINTS}/${MOMENTUM_WEIGHT} pts` };
  }
  // Strong momentum either way (>=5 favorable or <-5 against) -- middling,
  // roughly flat regardless of direction (~28-31% both ways in the mined data).
  return { points: MOMENTUM_STRONG_EITHER_WAY_POINTS, description: `market speed ${favorable.toFixed(2)} pts/min (strong, either direction) -- middling either way -- ${MOMENTUM_STRONG_EITHER_WAY_POINTS}/${MOMENTUM_WEIGHT} pts` };
}

export function scoreSetupV7(features: SetupFeatures): ScoreResult {
  const factors: FactorContribution[] = [];

  const maDistance = scoreMaDistanceAsymmetry(features.distanceFromMa20Atr, features.side);
  factors.push({ name: "maDistanceAsymmetry", contribution: maDistance.points, description: maDistance.description });

  const adxRegime = scoreAdxRegimeAsymmetry(features.adx, features.side);
  factors.push({ name: "adxRegimeAsymmetry", contribution: adxRegime.points, description: adxRegime.description });

  const momentumGrind = scoreMomentumGrind(features.netPointsPerMinute, features.side);
  factors.push({ name: "momentumGrind", contribution: momentumGrind.points, description: momentumGrind.description });

  const totalPoints = maDistance.points + adxRegime.points + momentumGrind.points;
  const probability = totalPoints / 100;

  return { probability, factors };
}
