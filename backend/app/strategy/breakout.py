"""Donchian-channel breakout: close beyond the prior N-bar high/low."""
from __future__ import annotations

from decimal import Decimal

import pandas as pd

from app.strategy.base import Signal, Strategy

LOOKBACK = 20


class BreakoutStrategy(Strategy):
    strategy_id = "breakout_donchian_20"

    def generate_signal(self, symbol: str, df: pd.DataFrame) -> Signal | None:
        if len(df) < LOOKBACK + 1:
            return None

        window = df.iloc[-(LOOKBACK + 1) : -1]  # prior N bars, excluding current
        prior_high = float(window["high"].max())
        prior_low = float(window["low"].min())
        last = df.iloc[-1]
        close = float(last["close"])

        if close > prior_high:
            return Signal(
                strategy_id=self.strategy_id,
                symbol=symbol,
                side="long",
                structure_swing_price=Decimal(str(prior_low)),
                reason=f"close {close} broke above the prior {LOOKBACK}-bar high of {prior_high}",
            )
        if close < prior_low:
            return Signal(
                strategy_id=self.strategy_id,
                symbol=symbol,
                side="short",
                structure_swing_price=Decimal(str(prior_high)),
                reason=f"close {close} broke below the prior {LOOKBACK}-bar low of {prior_low}",
            )
        return None
