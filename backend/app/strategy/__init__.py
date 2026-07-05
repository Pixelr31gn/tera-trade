from app.strategy.base import Signal, Strategy
from app.strategy.breakout import BreakoutStrategy
from app.strategy.mean_reversion import MeanReversionStrategy
from app.strategy.trend_following import TrendFollowingStrategy

ALL_STRATEGIES: list[Strategy] = [BreakoutStrategy(), MeanReversionStrategy(), TrendFollowingStrategy()]

__all__ = ["Signal", "Strategy", "ALL_STRATEGIES", "BreakoutStrategy", "MeanReversionStrategy", "TrendFollowingStrategy"]
