from app.regime.classifier import classify_regime


def test_classifies_strong_uptrend_as_trending_up(trending_bars):
    result = classify_regime(trending_bars)
    assert result.trend_label == "up"
    assert 0 <= result.confidence <= 1


def test_classifies_sideways_market_as_ranging(ranging_bars):
    result = classify_regime(ranging_bars)
    assert result.trend_label == "none"


def test_downtrend_detected(trending_bars):
    down_bars = trending_bars.copy()
    orig_high, orig_low = down_bars["high"], down_bars["low"]
    down_bars["open"] = 200 - down_bars["open"]
    down_bars["close"] = 200 - down_bars["close"]
    down_bars["high"] = 200 - orig_low
    down_bars["low"] = 200 - orig_high
    result = classify_regime(down_bars)
    assert result.trend_label == "down"
