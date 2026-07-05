"""Vectorized technical indicators used for regime detection and scoring features.

All functions take a DataFrame with columns open/high/low/close(/volume) indexed
by time (ascending) and return a pandas Series aligned to that index.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["close"].shift(1)
    ranges = pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()], axis=1
    )
    return ranges.max(axis=1)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    up_move = df["high"].diff()
    down_move = -df["low"].diff()

    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

    tr_smooth = true_range(df).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / tr_smooth
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / tr_smooth

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def bollinger_bandwidth(df: pd.DataFrame, period: int = 20, num_std: float = 2.0) -> pd.Series:
    sma = df["close"].rolling(period).mean()
    std = df["close"].rolling(period).std(ddof=0)
    upper = sma + num_std * std
    lower = sma - num_std * std
    return (upper - lower) / sma.replace(0, np.nan)


def choppiness_index(df: pd.DataFrame, period: int = 14) -> pd.Series:
    tr_sum = true_range(df).rolling(period).sum()
    high_max = df["high"].rolling(period).max()
    low_min = df["low"].rolling(period).min()
    span = (high_max - low_min).replace(0, np.nan)
    return 100 * np.log10(tr_sum / span) / np.log10(period)


def trend_slope_r2(df: pd.DataFrame, period: int = 20) -> tuple[pd.Series, pd.Series]:
    """Rolling linear-regression slope (in price units/bar) and R^2 of `close`."""
    close = df["close"]
    x = np.arange(period)
    x_mean = x.mean()
    x_var = ((x - x_mean) ** 2).sum()

    def _slope_r2(window: np.ndarray) -> tuple[float, float]:
        y = window
        y_mean = y.mean()
        cov = ((x - x_mean) * (y - y_mean)).sum()
        slope = cov / x_var if x_var else 0.0
        pred = slope * (x - x_mean) + y_mean
        ss_res = ((y - pred) ** 2).sum()
        ss_tot = ((y - y_mean) ** 2).sum()
        r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
        return slope, r2

    slopes = np.full(len(close), np.nan)
    r2s = np.full(len(close), np.nan)
    values = close.to_numpy()
    for i in range(period - 1, len(values)):
        s, r = _slope_r2(values[i - period + 1 : i + 1])
        slopes[i] = s
        r2s[i] = r
    return pd.Series(slopes, index=df.index), pd.Series(r2s, index=df.index)


def atr_percentile(df: pd.DataFrame, atr_period: int = 14, lookback: int = 100) -> pd.Series:
    atr_series = atr(df, atr_period)
    return atr_series.rolling(lookback, min_periods=max(10, lookback // 4)).rank(pct=True)


def realized_vol_zscore(df: pd.DataFrame, ret_period: int = 1, lookback: int = 100) -> pd.Series:
    returns = df["close"].pct_change(ret_period)
    rolling_mean = returns.rolling(lookback).mean()
    rolling_std = returns.rolling(lookback).std(ddof=0)
    return (returns - rolling_mean) / rolling_std.replace(0, np.nan)
