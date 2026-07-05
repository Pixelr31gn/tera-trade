"""Threshold gate: turns a raw probability into a taken/skipped decision.

Everything below `MIN_SCORE_THRESHOLD` is logged as "would not take" with its
full explanation -- it is never silently dropped, so the dashboard's
recommendation feed shows both what was traded and what was passed on and why.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.core.config import get_settings
from app.scoring.features import SetupFeatures
from app.scoring.rule_scorer import ScoreResult, score_setup
from app.scoring.training import MLScorer


@dataclass(frozen=True)
class GatedScore:
    probability: float
    decision: str  # taken | skipped_score
    factors: list
    model_used: str  # "rule_v1" | "ml_v1"


_ml_scorer_cache: MLScorer | None = None


def _get_ml_scorer() -> MLScorer | None:
    global _ml_scorer_cache
    if not MLScorer.is_available():
        return None
    if _ml_scorer_cache is None:
        _ml_scorer_cache = MLScorer()
    return _ml_scorer_cache


def evaluate_setup(features: SetupFeatures) -> GatedScore:
    settings = get_settings()
    ml_scorer = _get_ml_scorer()

    rule_result: ScoreResult = score_setup(features)
    if ml_scorer is not None:
        probability = ml_scorer.score_probability(features)
        model_used = "ml_v1"
        factors = rule_result.factors  # keep rule factors for human-readable explanation regardless of which model scored it
    else:
        probability = rule_result.probability
        model_used = "rule_v1"
        factors = rule_result.factors

    decision = "taken" if probability >= settings.min_score_threshold else "skipped_score"
    return GatedScore(probability=probability, decision=decision, factors=factors, model_used=model_used)
