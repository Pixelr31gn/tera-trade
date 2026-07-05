import pandas as pd
import pytest

from app.analytics.stats import compute_portfolio_stats, compute_trade_stats, max_drawdown, sharpe_ratio, sortino_ratio


def test_trade_stats_basic():
    trades = pd.DataFrame({"pnl": [100, -50, 200, -50, 300], "mae": [10, 20, 5, 15, 8], "mfe": [120, 30, 220, 40, 310]})
    stats = compute_trade_stats(trades)
    assert stats.trade_count == 5
    assert stats.win_rate == 3 / 5
    assert stats.expected_value == pytest.approx(100)
    assert stats.profit_factor == pytest.approx(600 / 100)
    assert stats.avg_win == pytest.approx((100 + 200 + 300) / 3)
    assert stats.avg_loss == pytest.approx(-50)


def test_trade_stats_empty():
    stats = compute_trade_stats(pd.DataFrame(columns=["pnl"]))
    assert stats.trade_count == 0
    assert stats.profit_factor is None


def test_trade_stats_no_losses_profit_factor_none():
    trades = pd.DataFrame({"pnl": [10, 20, 30]})
    stats = compute_trade_stats(trades)
    assert stats.profit_factor is None


def test_max_drawdown_detects_peak_to_trough():
    equity = pd.Series([100, 110, 105, 90, 95, 120])
    dd, duration = max_drawdown(equity)
    assert dd == pytest.approx((110 - 90) / 110)
    assert duration >= 1


def test_sharpe_and_sortino_positive_for_upward_drift():
    returns = pd.Series([0.01, 0.02, -0.005, 0.015, 0.01, 0.02, -0.01, 0.03])
    sharpe = sharpe_ratio(returns)
    sortino = sortino_ratio(returns)
    assert sharpe is not None and sharpe > 0
    assert sortino is not None and sortino > 0


def test_portfolio_stats_smoke():
    equity = pd.Series([100 + i + (1 if i % 5 == 0 else 0) for i in range(60)])
    stats = compute_portfolio_stats(equity)
    assert stats.max_drawdown_pct >= 0
    assert stats.volatility_annualized is None or stats.volatility_annualized >= 0
