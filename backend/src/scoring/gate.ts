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
import { getSettings } from "../core/config.js";
import type { TradingSession } from "../analytics/session.js";
import { LONG_TARGET_POINTS, MIN_LONG_TARGET_SAMPLE_SIZE, MIN_LONG_TARGET_WIN_RATE } from "../engine/fixedTargetEdgeCache.js";
import type { SetupFeatures } from "./features.js";
import { scoreSetup, type FactorContribution, type StrategyVersion } from "./ruleScorer.js";
import { MLScorer } from "./training.js";

export interface GatedScore {
  probability: number;
  decision: "taken" | "skipped_score";
  factors: FactorContribution[];
  modelUsed: "rule_v1" | "ml_v1";
  /** Set when a setup that otherwise cleared the probability threshold was blocked by a hard rule (e.g. the long-target-edge gate below) -- lets explainScore report the real reason instead of a misleading "below threshold". */
  blockReason: string | null;
}

const mlScorerCache = new Map<TradingSession, MLScorer | null>();

function getMlScorer(session: TradingSession): MLScorer | null {
  const cached = mlScorerCache.get(session);
  if (cached !== undefined) return cached;
  const scorer = MLScorer.isAvailable(session) ? new MLScorer(session) : null;
  mlScorerCache.set(session, scorer);
  return scorer;
}

export function evaluateSetup(features: SetupFeatures, version: StrategyVersion = "v1"): GatedScore {
  const settings = getSettings();
  const mlScorer = getMlScorer(features.session);

  const ruleResult = scoreSetup(features, version);
  const probability = mlScorer ? mlScorer.scoreProbability(features) : ruleResult.probability;
  const modelUsed: "rule_v1" | "ml_v1" = mlScorer ? "ml_v1" : "rule_v1";

  let decision: "taken" | "skipped_score" = probability >= settings.minScoreThreshold ? "taken" : "skipped_score";
  let blockReason: string | null = null;

  // Hard override, long setups only: only ever take a long if there's real
  // historical evidence -- not a guess -- that this exact (symbol, session)
  // context reaches a fixed +20pt move at least 67% of the time (see
  // engine/fixedTargetEdgeCache.ts). Re-evaluating actual session data showed
  // this bar is currently cleared almost nowhere, so this is expected to
  // block most/all longs until real evidence changes that.
  if (features.side === "long" && decision === "taken") {
    const hasEnoughSample = features.longTargetSampleSize >= MIN_LONG_TARGET_SAMPLE_SIZE;
    const meetsWinRate = hasEnoughSample && features.longTargetWinRate !== null && features.longTargetWinRate >= MIN_LONG_TARGET_WIN_RATE;
    if (!meetsWinRate) {
      decision = "skipped_score";
      blockReason = hasEnoughSample
        ? `historical rate of reaching a ${LONG_TARGET_POINTS}-point move in this session is only ${Math.round((features.longTargetWinRate ?? 0) * 100)}% over ${features.longTargetSampleSize} samples (needs ${Math.round(MIN_LONG_TARGET_WIN_RATE * 100)}%+)`
        : `not enough historical samples yet for a ${LONG_TARGET_POINTS}-point long in this session (${features.longTargetSampleSize}, needs ${MIN_LONG_TARGET_SAMPLE_SIZE}+)`;
    }
  }

  return { probability, decision, factors: ruleResult.factors, modelUsed, blockReason };
}
