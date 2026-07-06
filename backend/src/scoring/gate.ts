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
import type { SetupFeatures } from "./features.js";
import { scoreSetup, type FactorContribution } from "./ruleScorer.js";
import { MLScorer } from "./training.js";

export interface GatedScore {
  probability: number;
  decision: "taken" | "skipped_score";
  factors: FactorContribution[];
  modelUsed: "rule_v1" | "ml_v1";
}

const mlScorerCache = new Map<TradingSession, MLScorer | null>();

function getMlScorer(session: TradingSession): MLScorer | null {
  const cached = mlScorerCache.get(session);
  if (cached !== undefined) return cached;
  const scorer = MLScorer.isAvailable(session) ? new MLScorer(session) : null;
  mlScorerCache.set(session, scorer);
  return scorer;
}

export function evaluateSetup(features: SetupFeatures): GatedScore {
  const settings = getSettings();
  const mlScorer = getMlScorer(features.session);

  const ruleResult = scoreSetup(features);
  const probability = mlScorer ? mlScorer.scoreProbability(features) : ruleResult.probability;
  const modelUsed: "rule_v1" | "ml_v1" = mlScorer ? "ml_v1" : "rule_v1";

  const decision: "taken" | "skipped_score" = probability >= settings.minScoreThreshold ? "taken" : "skipped_score";
  return { probability, decision, factors: ruleResult.factors, modelUsed };
}
