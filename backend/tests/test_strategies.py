from app.strategy.breakout import BreakoutStrategy
from app.strategy.mean_reversion import MeanReversionStrategy
from app.strategy.trend_following import TrendFollowingStrategy


def test_breakout_fires_long_on_new_high(trending_bars):
    signal = BreakoutStrategy().generate_signal("ES", trending_bars)
    assert signal is not None
    assert signal.side == "long"


def test_mean_reversion_fires_on_band_extreme(ranging_bars):
    strategy = MeanReversionStrategy()
    found = None
    for i in range(30, len(ranging_bars)):
        window = ranging_bars.iloc[: i + 1]
        signal = strategy.generate_signal("ES", window)
        if signal is not None:
            found = signal
            break
    assert found is not None
    assert found.side in ("long", "short")


def test_trend_following_detects_crossover(trending_bars):
    strategy = TrendFollowingStrategy()
    fired = False
    for i in range(25, len(trending_bars)):
        window = trending_bars.iloc[: i + 1]
        signal = strategy.generate_signal("ES", window)
        if signal is not None:
            fired = True
            assert signal.side == "long"
            break
    assert fired
