"""Bollinger Band mean-reversion: fade a close outside the bands back to the mean.

Best suited to ranging regimes -- the scoring engine's trend_alignment factor
naturally penalizes this strategy's signals when the regime is strongly
trending, since a reversion trade against a strong trend is exactly the
"fights the trend" case.
"""
from __future__ import annotations

from decimal import Decimal

import pandas as pd

from app.strategy.base import Signal, Strategy

PERIOD = 20
NUM_STD = 2.0


class MeanReversionStrategy(Strategy):
    strategy_id = "mean_reversion_bollinger_20"

    def generate_signal(self, symbol: str, df: pd.DataFrame) -> Signal | None:
        if len(df) < PERIOD + 1:
            return None

        closes = df["close"]
        sma = closes.rolling(PERIOD).mean().iloc[-1]
        std = closes.rolling(PERIOD).std(ddof=0).iloc[-1]
        if pd.isna(sma) or pd.isna(std) or std == 0:
            return None

        upper = float(sma + NUM_STD * std)
        lower = float(sma - NUM_STD * std)
        last = df.iloc[-1]
        close = float(last["close"])

        if close < lower:
            return Signal(
                strategy_id=self.strategy_id,
                symbol=symbol,
                side="long",
                structure_swing_price=Decimal(str(float(last["low"]))),
                reason=f"close {close} is below the lower Bollinger Band ({lower:.2f}), reversion toward {sma:.2f} expected",
            )
        if close > upper:
            return Signal(
                strategy_id=self.strategy_id,
                symbol=symbol,
                side="short",
                structure_swing_price=Decimal(str(float(last["high"]))),
                reason=f"close {close} is above the upper Bollinger Band ({upper:.2f}), reversion toward {sma:.2f} expected",
            )
        return None
