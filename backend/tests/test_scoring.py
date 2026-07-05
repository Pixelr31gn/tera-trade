from app.regime.classifier import RegimeResult
from app.scoring.features import SetupFeatures
from app.scoring.gate import evaluate_setup
from app.scoring.rule_scorer import score_setup


def _features(**overrides) -> SetupFeatures:
    base = dict(
        symbol="ES", side="long", momentum_10=0.01, atr_normalized_range=1.0, distance_from_ma20_atr=0.5,
        volume_zscore=1.0, realized_vol_zscore=0.0, trend_label="up", vol_label="normal", regime_confidence=0.7,
        adx=30.0, slope_r2=0.6, hour_of_day_utc=15, is_rth_session=True, news_risk_flag=False, news_minutes_to_event=None,
    )
    base.update(overrides)
    return SetupFeatures(**base)


def test_aligned_trend_setup_scores_higher_than_counter_trend():
    aligned = score_setup(_features(trend_label="up", side="long"))
    counter = score_setup(_features(trend_label="down", side="long"))
    assert aligned.probability > counter.probability


def test_news_risk_meaningfully_lowers_score():
    calm = score_setup(_features(news_risk_flag=False))
    risky = score_setup(_features(news_risk_flag=True, news_minutes_to_event=5))
    assert risky.probability < calm.probability


def test_gate_blocks_low_probability_setups():
    gated = evaluate_setup(_features(trend_label="down", side="long", news_risk_flag=True, news_minutes_to_event=2, adx=15))
    assert gated.decision == "skipped_score"


def test_gate_allows_high_probability_setups():
    gated = evaluate_setup(_features(trend_label="up", side="long", momentum_10=0.03, adx=40, slope_r2=0.9))
    assert gated.decision == "taken"
    assert gated.probability >= 0.65
