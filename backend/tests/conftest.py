from __future__ import annotations

import numpy as np
import pandas as pd
import pytest


def make_trending_bars(periods: int = 200, start_price: float = 100.0, drift: float = 0.15, noise: float = 0.3, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    index = pd.date_range("2026-01-01", periods=periods, freq="min", tz="UTC")
    closes = start_price + np.cumsum(drift + rng.normal(0, noise, size=periods))
    highs = closes + np.abs(rng.normal(0.3, 0.1, size=periods))
    lows = closes - np.abs(rng.normal(0.3, 0.1, size=periods))
    opens = closes - rng.normal(0, 0.2, size=periods)
    volume = rng.integers(100, 1000, size=periods).astype(float)
    return pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": closes, "volume": volume}, index=index)


def make_ranging_bars(periods: int = 200, mid_price: float = 100.0, band: float = 2.0, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    index = pd.date_range("2026-01-01", periods=periods, freq="min", tz="UTC")
    closes = mid_price + band * np.sin(np.linspace(0, 12 * np.pi, periods)) + rng.normal(0, 0.05, size=periods)
    highs = closes + np.abs(rng.normal(0.15, 0.05, size=periods))
    lows = closes - np.abs(rng.normal(0.15, 0.05, size=periods))
    opens = closes - rng.normal(0, 0.1, size=periods)
    volume = rng.integers(100, 1000, size=periods).astype(float)
    return pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": closes, "volume": volume}, index=index)


@pytest.fixture
def trending_bars() -> pd.DataFrame:
    return make_trending_bars()


@pytest.fixture
def ranging_bars() -> pd.DataFrame:
    return make_ranging_bars()
