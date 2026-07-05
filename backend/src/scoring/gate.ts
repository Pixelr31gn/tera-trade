/**
 * Threshold gate: turns a raw probability into a taken/skipped decision.
 *
 * Everything below MIN_SCORE_THRESHOLD is logged as "would not take" with its
 * full explanation -- it is never silently dropped, so the dashboard's
 * recommendation feed shows both what was traded and what was passed on and why.
 */
import { getSettings } from "../core/config.js";
import type { SetupFeatures } from "./features.js";
import { scoreSetup, type FactorContribution } from "./ruleScorer.js";
import { MLScorer } from "./training.js";

export interface GatedScore {
  probability: number;
  decision: "taken" | "skipped_score";
  factors: FactorContribution[];
  modelUsed: "rule_v1" | "ml_v1";
}

let mlScorerCache: MLScorer | null = null;

function getMlScorer(): MLScorer | null {
  if (!MLScorer.isAvailable()) return null;
  if (!mlScorerCache) mlScorerCache = new MLScorer();
  return mlScorerCache;
}

export function evaluateSetup(features: SetupFeatures): GatedScore {
  const settings = getSettings();
  const mlScorer = getMlScorer();

  const ruleResult = scoreSetup(features);
  const probability = mlScorer ? mlScorer.scoreProbability(features) : ruleResult.probability;
  const modelUsed: "rule_v1" | "ml_v1" = mlScorer ? "ml_v1" : "rule_v1";

  const decision: "taken" | "skipped_score" = probability >= settings.minScoreThreshold ? "taken" : "skipped_score";
  return { probability, decision, factors: ruleResult.factors, modelUsed };
}
