"""Hard risk circuit breakers, independent of any strategy signal.

These checks run before every new trade and can also flip the global kill
switch (system_state.kill_switch), which blocks *all* new entries account-wide
until an operator clears it. They mirror the account rules Topstep itself
enforces (daily loss limit, trailing max drawdown) so Terra Trade never lets a
strategy dig the account into a hole the prop firm would already have failed
on.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class AccountRiskState:
    current_equity: Decimal
    peak_equity: Decimal
    daily_starting_equity: Decimal
    consecutive_losses: int
    trades_today: int


@dataclass(frozen=True)
class RiskLimitsConfig:
    per_trade_risk_pct: Decimal
    max_daily_loss_pct: Decimal
    max_trailing_drawdown_pct: Decimal
    max_consecutive_losses: int
    max_daily_trades: int
    max_position_size: int


@dataclass(frozen=True)
class CircuitBreakerDecision:
    allowed: bool
    trip_kill_switch: bool
    reason: str | None


def check_circuit_breakers(state: AccountRiskState, limits: RiskLimitsConfig) -> CircuitBreakerDecision:
    daily_loss_pct = (
        (state.daily_starting_equity - state.current_equity) / state.daily_starting_equity * Decimal("100")
        if state.daily_starting_equity > 0
        else Decimal("0")
    )
    if daily_loss_pct >= limits.max_daily_loss_pct:
        return CircuitBreakerDecision(
            False, True, f"daily loss of {daily_loss_pct:.2f}% has reached the {limits.max_daily_loss_pct}% daily loss limit"
        )

    trailing_dd_pct = (
        (state.peak_equity - state.current_equity) / state.peak_equity * Decimal("100") if state.peak_equity > 0 else Decimal("0")
    )
    if trailing_dd_pct >= limits.max_trailing_drawdown_pct:
        return CircuitBreakerDecision(
            False, True,
            f"trailing drawdown of {trailing_dd_pct:.2f}% has reached the {limits.max_trailing_drawdown_pct}% trailing drawdown limit",
        )

    if state.consecutive_losses >= limits.max_consecutive_losses:
        return CircuitBreakerDecision(
            False, False,
            f"{state.consecutive_losses} consecutive losses have reached the max-consecutive-losses limit of {limits.max_consecutive_losses}; pausing new entries",
        )

    if state.trades_today >= limits.max_daily_trades:
        return CircuitBreakerDecision(
            False, False, f"{state.trades_today} trades taken today have reached the max-daily-trades limit of {limits.max_daily_trades}"
        )

    return CircuitBreakerDecision(True, False, None)
