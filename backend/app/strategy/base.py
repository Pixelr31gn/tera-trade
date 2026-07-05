"""Pluggable strategy interface.

A Strategy only proposes candidate setups from price action -- it never sizes,
never places orders, and never sees news/regime data directly (those are
scored and risk-gated afterward). This keeps "what pattern fired" cleanly
separated from "should we trade it and how big."
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal

import pandas as pd


@dataclass(frozen=True)
class Signal:
    strategy_id: str
    symbol: str
    side: str  # long|short
    structure_swing_price: Decimal
    reason: str


class Strategy(ABC):
    strategy_id: str

    @abstractmethod
    def generate_signal(self, symbol: str, df: pd.DataFrame) -> Signal | None:
        """`df` is ascending OHLCV history ending at the current (just-closed) bar."""
        ...
