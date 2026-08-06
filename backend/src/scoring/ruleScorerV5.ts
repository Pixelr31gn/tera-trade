/**
 * v5 -- the first scoring version built directly from mined outcome data
 * rather than hand-designed intuition. Every factor below comes from
 * querying `scores.outcome_label` (win = "executed_win"/"missed_win", i.e.
 * including setups that were skipped/blocked but retrospectively simulated
 * as winners -- see engine/outcomeEvaluator.ts) across ~36,500 resolved
 * setups (2026-07-21 snapshot), grouped by side, since every pattern found
 * this way was meaningfully asymmetric between long and short. See the
 * add-scoring-version skill's "Step -1: mine real data" section for the
 * methodology and how to re-run this analysis as more data accumulates --
 * these constants are a snapshot, not fitted/refitted automatically, same
 * hand-set-from-real-data posture as v2's marketStructureEdge/liquidityEdge.
 *
 * Same weighted-logit shape as v1/v2 (ruleScorer.ts), not the points+
 * adjustments shape v3 uses -- simpler, and nothing here needs the
 * dual-hypothesis/directional-conviction machinery v3's design depends on.
 */
import type { SetupFeatures } from "./features.js";
import type { MarketStructureLabel, PriceActionLabel } from "../analytics/priceAction.js";
import type { FactorContribution, ScoreResult } from "./ruleScorer.js";

const BASE_LOGIT = -0.2; // same slight-negative-prior convention as v1/v2

// Measured overall win rate across every resolved (executed or simulated)
// setup at the time this was built -- the reference point every factor's
// raw signal is measured against, not a fair-coin 50%. This system's
// setups run at a positive-R:R floor (risk/tradePlan.ts), so a win rate
// meaningfully below 50% is expected and not itself a bad sign.
const BASELINE_WIN_RATE = 0.2912;

// Chosen so the single largest deviation actually observed (ADX>=40 short,
// +25.7pp) lands just under +1.0 raw, rather than being picked to hit an
// exact round number -- see clip() below for why "just under" matters less
// than "not zero at the extreme."
const WIN_RATE_SCALE = 4;

function clip(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

function winRateToRaw(winRate: number): number {
  return clip((winRate - BASELINE_WIN_RATE) * WIN_RATE_SCALE);
}

// Factor 1: ADX-regime asymmetry -- by far the strongest and largest-sample
// pattern found (n>1400/side in the >=40 bucket alone). A very-strong-trend
// reading is a large edge FOR shorts and a large edge AGAINST longs -- not
// "strong trend is good" in general, an opposite-signed asymmetry. Bucketed
// at 40 deliberately, not reusing analytics/priceAction.ts's own strong/weak
// split (adx>=35) -- the effect measured here is specifically concentrated
// above 40, and blending in the 35-40 range would dilute it.
const ADX_WIN_RATE_SHORT: [number, number][] = [
  [0, 0.235],
  [15, 0.324],
  [25, 0.29],
  [40, 0.548],
];
const ADX_WIN_RATE_LONG: [number, number][] = [
  [0, 0.279],
  [15, 0.279],
  [25, 0.304],
  [40, 0.197],
];

function bucketedWinRate(value: number, table: [number, number][]): number {
  let winRate = table[0]![1];
  for (const [threshold, rate] of table) {
    if (value >= threshold) winRate = rate;
  }
  return winRate;
}

function scoreAdxRegimeAsymmetry(adx: number | null, side: "long" | "short"): { raw: number; desc: string } {
  if (adx === null) return { raw: 0, desc: "no ADX reading available -- neutral" };
  const table = side === "short" ? ADX_WIN_RATE_SHORT : ADX_WIN_RATE_LONG;
  const winRate = bucketedWinRate(adx, table);
  const bucket = adx >= 40 ? "very strong (40+)" : adx >= 25 ? "strong (25-40)" : adx >= 15 ? "developing (15-25)" : "weak (<15)";
  return { raw: winRateToRaw(winRate), desc: `ADX=${adx.toFixed(1)}, ${bucket} trend -- historically ${(winRate * 100).toFixed(0)}% win rate for ${side}s in this regime` };
}

// Factor 2: weak-trend fade -- fading a WEAK trend (short into weak_uptrend,
// long into weak_downtrend) outperformed following one, for both sides.
// Strong trends and ranging conditions show no comparable edge either way.
const STRUCTURE_WIN_RATE_SHORT: Record<MarketStructureLabel, number> = {
  strong_uptrend: 0.28,
  weak_uptrend: 0.404,
  ranging: 0.303,
  weak_downtrend: 0.256,
  strong_downtrend: 0.288,
};
const STRUCTURE_WIN_RATE_LONG: Record<MarketStructureLabel, number> = {
  strong_uptrend: 0.336,
  weak_uptrend: 0.269,
  ranging: 0.258,
  weak_downtrend: 0.385,
  strong_downtrend: 0.309,
};

function scoreWeakTrendFade(label: MarketStructureLabel, side: "long" | "short"): { raw: number; desc: string } {
  const winRate = (side === "short" ? STRUCTURE_WIN_RATE_SHORT : STRUCTURE_WIN_RATE_LONG)[label];
  return { raw: winRateToRaw(winRate), desc: `market structure ${label} -- historically ${(winRate * 100).toFixed(0)}% win rate for ${side}s here` };
}

// Factor 3: price-action normalcy -- a "normal" most-recent candle
// outperformed every dramatic-looking shape (strong bodies, wick
// rejections, indecision dojis) for BOTH sides. Read as climax/exhaustion
// candles tending to fade rather than continue, though this is the
// smallest, least sample-differentiated effect of the three.
const PRICE_ACTION_WIN_RATE_SHORT: Record<PriceActionLabel, number> = {
  normal: 0.328,
  lower_wick_rejection: 0.282,
  strong_bullish_body: 0.28,
  indecision_doji: 0.267,
  upper_wick_rejection: 0.266,
  strong_bearish_body: 0.233,
};
const PRICE_ACTION_WIN_RATE_LONG: Record<PriceActionLabel, number> = {
  normal: 0.295,
  lower_wick_rejection: 0.283,
  upper_wick_rejection: 0.25,
  strong_bearish_body: 0.246,
  strong_bullish_body: 0.242,
  indecision_doji: 0.206,
};

function scorePriceActionNormalcy(label: PriceActionLabel, side: "long" | "short"): { raw: number; desc: string } {
  const winRate = (side === "short" ? PRICE_ACTION_WIN_RATE_SHORT : PRICE_ACTION_WIN_RATE_LONG)[label];
  return { raw: winRateToRaw(winRate), desc: `most recent candle: ${label} -- historically ${(winRate * 100).toFixed(0)}% win rate for ${side}s after this shape` };
}

// Weights reflect effect size/sample confidence measured, in the same
// hand-set-but-data-informed spirit as v2's marketStructureEdge/
// liquidityEdge -- not fit by regression. adxRegimeAsymmetry gets the
// largest weight since it's both the largest deviation from baseline and
// the largest-sample pattern found.
const WEIGHTS_V5 = {
  adxRegimeAsymmetry: 2.0,
  weakTrendFade: 1.3,
  priceActionNormalcy: 0.7,
};

export function scoreSetupV5(features: SetupFeatures): ScoreResult {
  const side = features.side;
  const factors: FactorContribution[] = [];
  let logit = BASE_LOGIT;

  const push = (name: keyof typeof WEIGHTS_V5, raw: number, description: string) => {
    const contribution = WEIGHTS_V5[name] * raw;
    logit += contribution;
    factors.push({ name, contribution, description });
  };

  const adxResult = scoreAdxRegimeAsymmetry(features.adx, side);
  push("adxRegimeAsymmetry", adxResult.raw, adxResult.desc);

  const structureResult = scoreWeakTrendFade(features.marketStructureLabel, side);
  push("weakTrendFade", structureResult.raw, structureResult.desc);

  const priceActionResult = scorePriceActionNormalcy(features.priceActionLabel, side);
  push("priceActionNormalcy", priceActionResult.raw, priceActionResult.desc);

  const probability = 1 / (1 + Math.exp(-logit));
  return { probability, factors };
}
