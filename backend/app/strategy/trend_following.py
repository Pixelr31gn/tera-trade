"""EMA(9/21) crossover trend-following entry."""
from __future__ import annotations

from decimal import Decimal

import pandas as pd

from app.strategy.base import Signal, Strategy

FAST = 9
SLOW = 21
SWING_LOOKBACK = 10


class TrendFollowingStrategy(Strategy):
    strategy_id = "trend_following_ema_9_21"

    def generate_signal(self, symbol: str, df: pd.DataFrame) -> Signal | None:
        if len(df) < SLOW + 2:
            return None

        closes = df["close"]
        fast_ema = closes.ewm(span=FAST, adjust=False).mean()
        slow_ema = closes.ewm(span=SLOW, adjust=False).mean()

        prev_diff = fast_ema.iloc[-2] - slow_ema.iloc[-2]
        curr_diff = fast_ema.iloc[-1] - slow_ema.iloc[-1]

        swing_window = df.iloc[-(SWING_LOOKBACK + 1) : -1]

        if prev_diff <= 0 and curr_diff > 0:
            return Signal(
                strategy_id=self.strategy_id,
                symbol=symbol,
                side="long",
                structure_swing_price=Decimal(str(float(swing_window["low"].min()))),
                reason=f"{FAST}-EMA crossed above the {SLOW}-EMA, signaling a new up-trend",
            )
        if prev_diff >= 0 and curr_diff < 0:
            return Signal(
                strategy_id=self.strategy_id,
                symbol=symbol,
                side="short",
                structure_swing_price=Decimal(str(float(swing_window["high"].max()))),
                reason=f"{FAST}-EMA crossed below the {SLOW}-EMA, signaling a new down-trend",
            )
        return None
