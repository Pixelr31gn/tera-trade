"""Combines indicators into a (trend, volatility) regime label + confidence.

Trend axis: "up" | "down" | "none" (ranging)
Vol axis:   "high" | "normal" | "low"

Thresholds are conservative, documented defaults -- tune per-instrument once
enough regime_history/trade data accumulates.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from app.regime.indicators import (
    adx,
    atr_percentile,
    bollinger_bandwidth,
    choppiness_index,
    trend_slope_r2,
)

ADX_TREND_THRESHOLD = 25.0
CHOPPINESS_RANGE_THRESHOLD = 61.8  # classic Choppiness Index range-market threshold
SLOPE_R2_CONFIRM_THRESHOLD = 0.4
VOL_HIGH_PERCENTILE = 0.70
VOL_LOW_PERCENTILE = 0.30


@dataclass(frozen=True)
class RegimeResult:
    trend_label: str  # up|down|none
    vol_label: str  # high|normal|low
    confidence: float
    features: dict = field(default_factory=dict)


def classify_regime(df: pd.DataFrame) -> RegimeResult:
    """`df` must have >= ~120 rows of OHLC bars (enough for the 100-bar ATR
    percentile lookback); returns the regime for the *last* row."""
    adx_series = adx(df)
    chop_series = choppiness_index(df)
    bbw_series = bollinger_bandwidth(df)
    slope_series, r2_series = trend_slope_r2(df)
    atr_pct_series = atr_percentile(df)

    last_adx = _last_valid(adx_series)
    last_chop = _last_valid(chop_series)
    last_bbw = _last_valid(bbw_series)
    last_slope = _last_valid(slope_series)
    last_r2 = _last_valid(r2_series)
    last_atr_pct = _last_valid(atr_pct_series)

    features = {
        "adx": last_adx,
        "choppiness": last_chop,
        "bollinger_bandwidth": last_bbw,
        "slope": last_slope,
        "slope_r2": last_r2,
        "atr_percentile": last_atr_pct,
    }

    is_trending = (last_adx is not None and last_adx >= ADX_TREND_THRESHOLD) or (
        last_chop is not None and last_chop <= (100 - CHOPPINESS_RANGE_THRESHOLD)
    )
    if is_trending and last_slope is not None and last_r2 is not None and last_r2 >= SLOPE_R2_CONFIRM_THRESHOLD:
        trend_label = "up" if last_slope > 0 else "down"
        trend_confidence = min(1.0, (last_adx or 0) / 50) * last_r2
    else:
        trend_label = "none"
        trend_confidence = 1 - min(1.0, (last_adx or 0) / ADX_TREND_THRESHOLD)

    if last_atr_pct is None:
        vol_label = "normal"
        vol_confidence = 0.5
    elif last_atr_pct >= VOL_HIGH_PERCENTILE:
        vol_label = "high"
        vol_confidence = last_atr_pct
    elif last_atr_pct <= VOL_LOW_PERCENTILE:
        vol_label = "low"
        vol_confidence = 1 - last_atr_pct
    else:
        vol_label = "normal"
        vol_confidence = 0.5

    confidence = round((trend_confidence + vol_confidence) / 2, 4)
    return RegimeResult(trend_label=trend_label, vol_label=vol_label, confidence=confidence, features=features)


def _last_valid(series: pd.Series) -> float | None:
    valid = series.dropna()
    if valid.empty:
        return None
    return float(valid.iloc[-1])
