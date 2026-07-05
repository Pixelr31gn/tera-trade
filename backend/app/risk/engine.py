"""Risk engine: the single gate every candidate trade must pass through.

Order of checks (fail fast, cheapest/most-important first):
1. Circuit breakers (daily loss, trailing drawdown, consecutive losses, daily trade cap)
2. News-event risk window
3. Stop-loss plan (structure vs ATR) -- no valid stop, no trade
4. Position sizing from the stop distance -- if it sizes to zero contracts, no trade
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.news.risk import NewsRiskStatus
from app.risk.circuit_breakers import AccountRiskState, CircuitBreakerDecision, RiskLimitsConfig, check_circuit_breakers
from app.risk.sizing import compute_position_size
from app.risk.stops import StopPlan, compute_initial_stop


@dataclass(frozen=True)
class RiskAssessment:
    approved: bool
    quantity: int
    stop_price: Decimal | None
    take_profit_price: Decimal | None
    trail_ticks: int | None
    stop_distance_points: Decimal | None
    reason: str
    trip_kill_switch: bool = False


class RiskEngine:
    def assess_new_trade(
        self,
        *,
        side: str,
        entry_price: Decimal,
        atr_value: Decimal,
        structure_swing_price: Decimal | None,
        account_state: AccountRiskState,
        limits: RiskLimitsConfig,
        point_value: Decimal,
        tick_size: Decimal,
        news_status: NewsRiskStatus,
    ) -> RiskAssessment:
        breaker: CircuitBreakerDecision = check_circuit_breakers(account_state, limits)
        if not breaker.allowed:
            return RiskAssessment(False, 0, None, None, None, None, breaker.reason or "circuit breaker tripped", breaker.trip_kill_switch)

        if news_status.in_risk_window:
            minutes = news_status.minutes_to_event
            when = f"in {minutes:.0f} min" if minutes and minutes > 0 else f"{abs(minutes or 0):.0f} min ago"
            return RiskAssessment(
                False, 0, None, None, None, None,
                f"blocked by news risk window: '{news_status.nearest_event_name}' ({news_status.impact} impact) {when}",
            )

        stop_plan: StopPlan = compute_initial_stop(
            entry_price=entry_price, side=side, atr_value=atr_value, structure_swing_price=structure_swing_price,
            tick_size=tick_size,
        )

        sizing = compute_position_size(
            account_equity=account_state.current_equity,
            per_trade_risk_pct=limits.per_trade_risk_pct,
            stop_distance_points=stop_plan.stop_distance_points,
            point_value=point_value,
            max_position_size=limits.max_position_size,
        )
        return RiskAssessment(
            approved=sizing.quantity > 0,
            quantity=sizing.quantity,
            stop_price=stop_plan.stop_price,
            take_profit_price=stop_plan.take_profit_price,
            trail_ticks=stop_plan.trail_ticks,
            stop_distance_points=stop_plan.stop_distance_points,
            reason=sizing.reason,
        )
