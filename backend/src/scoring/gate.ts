/**
 * Threshold gate: turns a raw probability into a taken/skipped decision.
 *
 * Everything below MIN_SCORE_THRESHOLD is logged as "would not take" with its
 * full explanation -- it is never silently dropped, so the dashboard's
 * recommendation feed shows both what was traded and what was passed on and why.
 *
 * The ML scorer is selected per trading session (see scoring/training.ts) --
 * New York, London, and Asian setups are never scored by one shared model.
 * A session falls back to the rule-based scorer until it has enough labeled
 * outcomes to have a trained model of its own.
 */
import type { OhlcBar } from "../regime/indicators.js";
import { getSettings } from "../core/config.js";
import type { TradingSession } from "../analytics/session.js";
import type { SetupFeatures } from "./features.js";
import { scoreSetup, type FactorContribution, type StrategyVersion } from "./ruleScorer.js";
import { computeBreakoutStrengthAdjustment, computeEmaProximityAdjustment, computeFibAdjustment, computeOrderFlowAdjustment, computePpmAdjustment, computeRiskRewardAdjustment, computeV3Bucket, scoreSetupV3Directional } from "./ruleScorerV3.js";
import { scoreSetupV5 } from "./ruleScorerV5.js";
import { scoreSetupV6 } from "./ruleScorerV6.js";
import { computeHistoricalAdjustment } from "./v3HistoricalAdjustment.js";
import { MLScorer } from "./training.js";

export interface GatedScore {
  probability: number;
  decision: "taken" | "skipped_score";
  factors: FactorContribution[];
  modelUsed: "rule_v1" | "ml_v4" | "rule_v1_fallback" | "rule_v3" | "rule_v5" | "rule_v6";
  /** Set when a setup that otherwise cleared the probability threshold was blocked by a hard rule (v3's directional-conviction check below) -- lets explainScore report the real reason instead of a misleading "below threshold". */
  blockReason: string | null;
  /** Only set for v3 -- the categorical fingerprint this setup was scored under, persisted on the Score row so future setups can look up how similar-looking ones performed (see v3HistoricalAdjustment.ts). */
  v3Bucket: string | null;
}

const mlScorerCache = new Map<TradingSession, MLScorer | null>();

function getMlScorer(session: TradingSession): MLScorer | null {
  const cached = mlScorerCache.get(session);
  if (cached !== undefined) return cached;
  const scorer = MLScorer.isAvailable(session) ? new MLScorer(session) : null;
  mlScorerCache.set(session, scorer);
  return scorer;
}

// v3 requires real directional conviction, not just a score that happens to
// clear the threshold -- if the opposite-direction hypothesis is nearly as
// strong, that's exactly the ambiguous case the spec says to sit out (its
// worked example: 66% bullish vs 63% bearish -> no trade, despite 66
// nominally clearing 65%). Hand-set margin, not fitted. (2026-07-20: lowered
// 10 -> 7 -- operator judged several 8-9 point margins as good enough to
// take rather than sit out.)
const MIN_DIRECTIONAL_MARGIN_POINTS = 7;

/** Pure -- no DB access -- so the override rule itself is directly unit-testable (see tests/scoring.test.ts). */
export function shouldOverrideToTaken(v1Gated: GatedScore | undefined, v2Gated: GatedScore | undefined): boolean {
  return v1Gated?.decision === "taken" && v2Gated?.decision === "taken";
}

/**
 * v3's own directional-conviction override (v1v2Override below) and v6's
 * ensemble base both need OTHER versions' already-computed results -- this
 * carries whichever ones the caller has on hand at that point. Field usage
 * by version: v3 needs bars/v1Gated/v2Gated/signalKind; v6 needs
 * bars/v1Gated/v2Gated/v3Gated/v5Gated. Was v3-only ("v3Inputs") until v6
 * needed the same shape (2026-08-02) -- renamed rather than adding a second,
 * near-identical parameter.
 */
export interface ScoringInputs {
  bars: OhlcBar[];
  v1Gated?: GatedScore;
  v2Gated?: GatedScore;
  v3Gated?: GatedScore;
  v5Gated?: GatedScore;
  signalKind?: "breakout" | "reversal";
}

export async function evaluateSetup(
  features: SetupFeatures,
  version: StrategyVersion = "v1",
  /** As-of time for this setup's decision -- threaded to computeHistoricalAdjustment's time bound (see that file's comment). Always the bar/signal time, never wall-clock Date.now(), so replay can pass a historical bar time and get the same look-ahead protection live gets for free. */
  at: Date,
  extra?: ScoringInputs
): Promise<GatedScore> {
  const settings = getSettings();

  if (version === "v3") {
    // v3 is a different scoring *mechanism* entirely (six independent
    // 0-100-point factors evaluated for both directions) -- it doesn't go
    // through the v4 ML-scorer branch below.
    if (!extra) throw new Error("evaluateSetup: extra is required when version is 'v3'");
    const v3Inputs = extra;
    const { readings, bullish, bearish } = scoreSetupV3Directional(v3Inputs.bars, features);
    const mySide = features.side === "long" ? bullish : bearish;
    const otherSide = features.side === "long" ? bearish : bullish;
    const bucket = computeV3Bucket(readings, features.side);

    const historical = await computeHistoricalAdjustment(features.symbol, bucket, at);

    // Breakout conviction adjustment -- only meaningful for breakout-kind
    // signals (see ruleScorerV3.ts's computeBreakoutStrengthAdjustment for
    // why: it reads where the breakout bar closed within its own range,
    // which isn't a relevant conviction signal for a reversal/bounce setup).
    const breakoutStrength =
      v3Inputs.signalKind === "breakout" ? computeBreakoutStrengthAdjustment(v3Inputs.bars.at(-1)!, features.side) : null;

    // Applied to every setup (not just breakouts) -- unlike breakoutStrength,
    // risk/reward shape is a meaningful conviction signal regardless of
    // signal kind.
    const riskReward = computeRiskRewardAdjustment(features.riskRewardRatio);
    const fib = computeFibAdjustment(features.fibSwingDirection, features.fibRetracementPct, features.side);
    const ppm = computePpmAdjustment(features.netPointsPerMinute, features.side);
    const orderFlow = computeOrderFlowAdjustment(features.orderFlowSnapshot, features.side);
    const emaProximity = computeEmaProximityAdjustment(features.intraday5mEmaDistanceAtr, features.side);

    const adjustedScore = Math.max(
      0,
      Math.min(
        100,
        mySide.score +
          historical.adjustmentPoints +
          (breakoutStrength?.adjustmentPoints ?? 0) +
          riskReward.adjustmentPoints +
          fib.adjustmentPoints +
          ppm.adjustmentPoints +
          orderFlow.adjustmentPoints +
          emaProximity.adjustmentPoints
      )
    );
    const probability = Math.round((adjustedScore / 100) * 1e5) / 1e5;

    const margin = mySide.score - otherSide.score;
    const clearsThreshold = probability >= settings.minScoreThreshold;
    const hasConviction = margin >= MIN_DIRECTIONAL_MARGIN_POINTS;
    let decision: "taken" | "skipped_score" = clearsThreshold && hasConviction ? "taken" : "skipped_score";
    let blockReason =
      clearsThreshold && !hasConviction
        ? `insufficient directional conviction: ${features.side} scored ${mySide.score.toFixed(0)} vs the opposite direction's ${otherSide.score.toFixed(0)} (needs a ${MIN_DIRECTIONAL_MARGIN_POINTS}+ point margin)`
        : null;

    const factors: FactorContribution[] = [
      ...mySide.factors.map((f) => ({ name: f.name, contribution: f.points, description: `${f.description} (${f.points.toFixed(1)}/${f.maxPoints} pts)` })),
      {
        name: "historicalAdjustment",
        contribution: historical.adjustmentPoints,
        description:
          historical.winRate !== null
            ? `similar setups won ${(historical.winRate * 100).toFixed(0)}% of the last ${historical.sampleSize} -- ${historical.adjustmentPoints >= 0 ? "+" : ""}${historical.adjustmentPoints.toFixed(1)} pt adjustment`
            : `only ${historical.sampleSize} similar resolved setup(s) so far -- not enough for a historical adjustment yet`,
      },
      {
        name: "directionalConviction",
        contribution: margin,
        description: `${features.side} scored ${mySide.score.toFixed(0)} vs opposite-direction ${otherSide.score.toFixed(0)} (margin ${margin.toFixed(0)})`,
      },
    ];
    if (breakoutStrength) {
      factors.push({ name: "breakoutStrength", contribution: breakoutStrength.adjustmentPoints, description: breakoutStrength.description });
    }
    factors.push({ name: "riskRewardAdjustment", contribution: riskReward.adjustmentPoints, description: riskReward.description });
    factors.push({ name: "fibDirectionAdjustment", contribution: fib.adjustmentPoints, description: fib.description });
    factors.push({ name: "ppmAdjustment", contribution: ppm.adjustmentPoints, description: ppm.description });
    factors.push({ name: "orderFlowAdjustment", contribution: orderFlow.adjustmentPoints, description: orderFlow.description });
    factors.push({ name: "emaProximityAdjustment", contribution: emaProximity.adjustmentPoints, description: emaProximity.description });

    // Hard override: if v1 AND v2 both independently took this exact same
    // setup, v3 takes it too, even if its own score/conviction check
    // wouldn't otherwise clear the bar. v3's own probability is left
    // untouched (never fabricated to look like it agrees) -- only the
    // decision is forced, and the override is spelled out in both the
    // factors list and blockReason so the explanation never silently
    // implies v3 agreed on its own.
    if (decision === "taken") {
      factors.push({ name: "v1v2Agreement", contribution: 0, description: "v1 and v2 already agreed -- override not needed" });
    } else if (shouldOverrideToTaken(v3Inputs.v1Gated, v3Inputs.v2Gated)) {
      decision = "taken";
      blockReason = null;
      factors.push({
        name: "v1v2Override",
        contribution: 0,
        description: `overridden to taken: v1 (${Math.round(v3Inputs.v1Gated!.probability * 100)}%) and v2 (${Math.round(v3Inputs.v2Gated!.probability * 100)}%) both independently took this setup, despite v3's own score of ${Math.round(probability * 100)}%`,
      });
    }

    return { probability, decision, factors, modelUsed: "rule_v3", blockReason, v3Bucket: bucket };
  }

  if (version === "v5") {
    // v5 is a plain weighted-logit scorer (same shape as v1/v2) built from
    // real mined outcome patterns, not v3's dual-hypothesis/adjustment
    // machinery -- no v3Inputs, no directional-conviction margin, no
    // historical-similarity lookup. See ruleScorerV5.ts's header for where
    // its factors came from.
    const result = scoreSetupV5(features);
    const decision: "taken" | "skipped_score" = result.probability >= settings.minScoreThreshold ? "taken" : "skipped_score";
    return { probability: result.probability, decision, factors: result.factors, modelUsed: "rule_v5", blockReason: null, v3Bucket: null };
  }

  if (version === "v6") {
    // v6 is a complete, self-contained scorer as of 2026-08-03 (operator
    // spec: five weighted criteria on the trend-pullback-fib setup) -- it no
    // longer averages v1/v2/v3/v5 internally, so unlike the version this
    // replaced, it doesn't need their GatedScores as input. It only needs
    // the raw bars (see ruleScorerV6.ts's header for the full breakdown).
    // The outer v6-mandatory consensus rule (engine/loop.ts) still requires
    // v1/v2/v3/v5's OWN results to exist in gatedByVersion, but that's a
    // separate map this function's caller manages, not something evaluateSetup
    // itself needs to see.
    if (!extra?.bars) {
      throw new Error("evaluateSetup: extra.bars is required when version is 'v6'");
    }
    const result = scoreSetupV6(features, extra.bars);
    const decision: "taken" | "skipped_score" = result.probability >= settings.minScoreThreshold ? "taken" : "skipped_score";
    return { probability: result.probability, decision, factors: result.factors, modelUsed: "rule_v6", blockReason: null, v3Bucket: null };
  }

  // v4 is the independently-trained ML model (see scoring/training.ts) --
  // it must actually run the trained model, not silently be handed the same
  // rule-based score v1 gets. The whole point of the 3-way consensus (v1 +
  // v3 + v4) is that the voters use genuinely different methodology; if v4
  // secretly fell back to the same rule-based scorer whenever it agreed with
  // v1, they wouldn't be independent evidence at all. It only falls back to
  // the rule-based scorer if a session's model genuinely isn't trained yet
  // (see MIN_TRAINING_ROWS_PER_SESSION) -- keeps the engine loop from
  // crashing on a session with too little data, at the cost of that session
  // temporarily not having a real independent third vote.
  const ruleResult = scoreSetup(features, version);
  let probability: number;
  let modelUsed: "rule_v1" | "ml_v4" | "rule_v1_fallback";
  if (version === "v4") {
    const mlScorer = getMlScorer(features.session);
    probability = mlScorer ? mlScorer.scoreProbability(features) : ruleResult.probability;
    modelUsed = mlScorer ? "ml_v4" : "rule_v1_fallback";
  } else {
    probability = ruleResult.probability;
    modelUsed = "rule_v1";
  }
  const factors = ruleResult.factors;

  const decision: "taken" | "skipped_score" = probability >= settings.minScoreThreshold ? "taken" : "skipped_score";

  // The fixed +20pt-move hard gate that used to sit here (only ever take a
  // long if a fixed 20pt target had a 67%+ historical hit rate in this exact
  // symbol/session) has been removed: it assumed a single fixed distance
  // generalizes across days, when in practice conditions vary session to
  // session and the gate was blocking nearly every long regardless of how
  // good the setup actually was. Direction/entry quality is judged entirely
  // by the scoring model's own factors now -- features.longTargetWinRate/
  // longTargetSampleSize are still computed and stored for reference, just
  // no longer enforced.
  return { probability, decision, factors, modelUsed, blockReason: null, v3Bucket: null };
}
