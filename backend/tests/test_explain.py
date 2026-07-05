from decimal import Decimal

from app.explain.engine import explain_kill_switch, explain_news_pause, explain_trade_exit
from app.risk.engine import RiskAssessment
from app.scoring.gate import GatedScore
from app.scoring.rule_scorer import FactorContribution
from app.explain.engine import explain_risk_rejection, explain_score


def _gated(decision: str, probability: float = 0.7) -> GatedScore:
    factors = [FactorContribution("trend_alignment", 1.1, "setup direction agrees with the prevailing up trend")]
    return GatedScore(probability=probability, decision=decision, factors=factors, model_used="rule_v1")


def test_explain_score_mentions_probability_and_threshold():
    text = explain_score("ES", "long", _gated("taken", 0.72), threshold=0.65)
    assert "72%" in text
    assert "65%" in text
    assert "LONG ES" in text


def test_explain_score_skipped_says_no_trade_taken():
    text = explain_score("ES", "long", _gated("skipped_score", 0.4), threshold=0.65)
    assert "no trade taken" in text


def test_explain_risk_rejection_includes_reason():
    assessment = RiskAssessment(False, 0, None, None, None, None, "blocked by news risk window: 'CPI' (high impact) in 5 min")
    text = explain_risk_rejection("ES", "long", assessment)
    assert "CPI" in text


def test_explain_trade_exit_stop_vs_target():
    stop_text = explain_trade_exit("ES", "long", "stop", Decimal("4995"), Decimal("-250"))
    target_text = explain_trade_exit("ES", "long", "target", Decimal("5010"), Decimal("500"))
    assert "loss" in stop_text
    assert "gain" in target_text


def test_explain_news_pause_and_kill_switch():
    pause_text = explain_news_pause("ES", "CPI", "high", 10)
    assert "CPI" in pause_text and "10 minutes" in pause_text

    kill_text = explain_kill_switch("daily loss of 4.00% has reached the 3% daily loss limit")
    assert "Kill switch engaged" in kill_text
