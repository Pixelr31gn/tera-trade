"""Professional-grade trade & portfolio statistics.

All functions are pure (pandas/numpy in, dataclass out) so they're trivially
unit-testable against synthetic trade sets and reusable from both the API
layer and the offline scoring-model training pipeline.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

TRADING_PERIODS_PER_YEAR = 252


@dataclass(frozen=True)
class TradeStats:
    trade_count: int
    win_rate: float
    expected_value: float  # average pnl per trade, in account currency
    profit_factor: float | None  # gross profit / gross loss; None if no losses
    avg_win: float
    avg_loss: float
    avg_mae: float | None
    avg_mfe: float | None
    largest_win: float
    largest_loss: float


@dataclass(frozen=True)
class PortfolioStats:
    sharpe: float | None
    sortino: float | None
    max_drawdown_pct: float
    max_drawdown_duration_days: int
    volatility_annualized: float | None
    cagr: float | None


def compute_trade_stats(trades: pd.DataFrame) -> TradeStats:
    """`trades` must have a `pnl` column (float, account currency) and may have
    `mae`/`mfe` columns (points, always >= 0 by convention)."""
    if trades.empty:
        return TradeStats(0, 0.0, 0.0, None, 0.0, 0.0, None, None, 0.0, 0.0)

    pnl = trades["pnl"].astype(float)
    wins = pnl[pnl > 0]
    losses = pnl[pnl < 0]

    gross_profit = wins.sum()
    gross_loss = -losses.sum()
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else None

    return TradeStats(
        trade_count=len(pnl),
        win_rate=len(wins) / len(pnl) if len(pnl) else 0.0,
        expected_value=float(pnl.mean()),
        profit_factor=profit_factor,
        avg_win=float(wins.mean()) if len(wins) else 0.0,
        avg_loss=float(losses.mean()) if len(losses) else 0.0,
        avg_mae=float(trades["mae"].astype(float).mean()) if "mae" in trades and trades["mae"].notna().any() else None,
        avg_mfe=float(trades["mfe"].astype(float).mean()) if "mfe" in trades and trades["mfe"].notna().any() else None,
        largest_win=float(wins.max()) if len(wins) else 0.0,
        largest_loss=float(losses.min()) if len(losses) else 0.0,
    )


def max_drawdown(equity: pd.Series) -> tuple[float, int]:
    """Returns (max_drawdown_pct as a positive fraction, duration in periods of the
    equity series' own index -- caller interprets units, e.g. days)."""
    if equity.empty:
        return 0.0, 0
    running_max = equity.cummax()
    drawdown = (equity - running_max) / running_max
    max_dd = float(-drawdown.min()) if len(drawdown) else 0.0

    # Duration of the longest underwater stretch.
    underwater = drawdown < 0
    longest = current = 0
    for is_under in underwater:
        current = current + 1 if is_under else 0
        longest = max(longest, current)
    return max_dd, longest


def realized_volatility(returns: pd.Series, annualize: bool = True) -> float | None:
    if returns.empty or returns.std(ddof=1) != returns.std(ddof=1):  # NaN check
        return None
    vol = float(returns.std(ddof=1))
    if annualize:
        vol *= math.sqrt(TRADING_PERIODS_PER_YEAR)
    return vol


def sharpe_ratio(returns: pd.Series, risk_free_rate: float = 0.0, annualize: bool = True) -> float | None:
    if returns.empty or len(returns) < 2:
        return None
    excess = returns - (risk_free_rate / TRADING_PERIODS_PER_YEAR)
    std = excess.std(ddof=1)
    if std == 0 or np.isnan(std):
        return None
    ratio = excess.mean() / std
    if annualize:
        ratio *= math.sqrt(TRADING_PERIODS_PER_YEAR)
    return float(ratio)


def sortino_ratio(returns: pd.Series, risk_free_rate: float = 0.0, annualize: bool = True) -> float | None:
    if returns.empty or len(returns) < 2:
        return None
    excess = returns - (risk_free_rate / TRADING_PERIODS_PER_YEAR)
    downside = excess[excess < 0]
    downside_std = downside.std(ddof=1) if len(downside) > 1 else 0.0
    if not downside_std or np.isnan(downside_std):
        return None
    ratio = excess.mean() / downside_std
    if annualize:
        ratio *= math.sqrt(TRADING_PERIODS_PER_YEAR)
    return float(ratio)


def cagr(equity: pd.Series) -> float | None:
    if equity.empty or len(equity) < 2 or equity.iloc[0] <= 0:
        return None
    periods = len(equity)
    years = periods / TRADING_PERIODS_PER_YEAR
    if years <= 0:
        return None
    total_return = equity.iloc[-1] / equity.iloc[0]
    if total_return <= 0:
        return None
    return float(total_return ** (1 / years) - 1)


def compute_portfolio_stats(equity: pd.Series) -> PortfolioStats:
    """`equity` is a time-indexed series of account equity (daily or per-bar)."""
    returns = equity.pct_change().dropna()
    dd, dd_duration = max_drawdown(equity)
    return PortfolioStats(
        sharpe=sharpe_ratio(returns),
        sortino=sortino_ratio(returns),
        max_drawdown_pct=dd,
        max_drawdown_duration_days=dd_duration,
        volatility_annualized=realized_volatility(returns),
        cagr=cagr(equity),
    )
