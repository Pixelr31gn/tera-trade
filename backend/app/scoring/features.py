"""Feature vector construction for a candidate trade setup.

Shared by both the v1 rule-based scorer and the offline ML training pipeline,
so a model trained later sees exactly the same features the live rule scorer
used to generate the trades it's training on.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from app.regime.classifier import RegimeResult
from app.regime.indicators import atr, realized_vol_zscore


@dataclass(frozen=True)
class SetupFeatures:
    symbol: str
    side: str  # long|short
    momentum_10: float | None
    atr_normalized_range: float | None
    distance_from_ma20_atr: float | None
    volume_zscore: float | None
    realized_vol_zscore: float | None
    trend_label: str
    vol_label: str
    regime_confidence: float
    adx: float | None
    slope_r2: float | None
    hour_of_day_utc: int
    is_rth_session: bool
    news_risk_flag: bool
    news_minutes_to_event: float | None
    strategy_historical_win_rate: float | None = None

    def as_dict(self) -> dict:
        d = dict(self.__dict__)
        return d


def build_setup_features(
    df: pd.DataFrame,
    symbol: str,
    side: str,
    regime: RegimeResult,
    now: dt.datetime,
    news_risk_flag: bool,
    news_minutes_to_event: float | None,
    strategy_historical_win_rate: float | None = None,
) -> SetupFeatures:
    """`df` is the recent OHLCV history for `symbol`, ascending by time, last row = current bar."""
    close = df["close"]
    atr_series = atr(df)
    last_atr = float(atr_series.dropna().iloc[-1]) if atr_series.notna().any() else None

    momentum_10 = None
    if len(close) > 10:
        momentum_10 = float((close.iloc[-1] - close.iloc[-11]) / close.iloc[-11]) if close.iloc[-11] else None

    atr_normalized_range = None
    if last_atr and last_atr > 0:
        last_bar = df.iloc[-1]
        atr_normalized_range = float((last_bar["high"] - last_bar["low"]) / last_atr)

    sma20 = close.rolling(20).mean()
    distance_from_ma20_atr = None
    if last_atr and last_atr > 0 and sma20.notna().any():
        distance_from_ma20_atr = float((close.iloc[-1] - sma20.iloc[-1]) / last_atr)

    volume_zscore = None
    if "volume" in df.columns:
        vol = df["volume"]
        rolling_mean = vol.rolling(50).mean()
        rolling_std = vol.rolling(50).std(ddof=0)
        if rolling_std.notna().any() and rolling_std.iloc[-1]:
            volume_zscore = float((vol.iloc[-1] - rolling_mean.iloc[-1]) / rolling_std.iloc[-1])

    rv_z_series = realized_vol_zscore(df)
    rv_z = float(rv_z_series.dropna().iloc[-1]) if rv_z_series.notna().any() else None

    hour = now.hour
    is_rth = 13 <= hour < 20  # ~9:30am-4pm ET in UTC, ignoring DST nuance

    return SetupFeatures(
        symbol=symbol,
        side=side,
        momentum_10=momentum_10,
        atr_normalized_range=atr_normalized_range,
        distance_from_ma20_atr=distance_from_ma20_atr,
        volume_zscore=volume_zscore,
        realized_vol_zscore=rv_z,
        trend_label=regime.trend_label,
        vol_label=regime.vol_label,
        regime_confidence=regime.confidence,
        adx=regime.features.get("adx"),
        slope_r2=regime.features.get("slope_r2"),
        hour_of_day_utc=hour,
        is_rth_session=is_rth,
        news_risk_flag=news_risk_flag,
        news_minutes_to_event=news_minutes_to_event,
        strategy_historical_win_rate=strategy_historical_win_rate,
    )
