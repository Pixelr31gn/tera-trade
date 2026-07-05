from decimal import Decimal

from app.risk.circuit_breakers import AccountRiskState, RiskLimitsConfig, check_circuit_breakers

LIMITS = RiskLimitsConfig(
    per_trade_risk_pct=Decimal("0.5"),
    max_daily_loss_pct=Decimal("3"),
    max_trailing_drawdown_pct=Decimal("6"),
    max_consecutive_losses=3,
    max_daily_trades=8,
    max_position_size=3,
)


def test_allows_trade_within_all_limits():
    state = AccountRiskState(Decimal("50000"), Decimal("51000"), Decimal("50200"), 0, 1)
    decision = check_circuit_breakers(state, LIMITS)
    assert decision.allowed


def test_daily_loss_limit_trips_kill_switch():
    state = AccountRiskState(Decimal("48000"), Decimal("51000"), Decimal("50000"), 0, 1)  # -4% today
    decision = check_circuit_breakers(state, LIMITS)
    assert not decision.allowed
    assert decision.trip_kill_switch


def test_trailing_drawdown_trips_kill_switch():
    state = AccountRiskState(Decimal("47000"), Decimal("51000"), Decimal("50500"), 0, 1)  # -7.8% trailing
    decision = check_circuit_breakers(state, LIMITS)
    assert not decision.allowed
    assert decision.trip_kill_switch


def test_consecutive_losses_pauses_without_kill_switch():
    state = AccountRiskState(Decimal("50000"), Decimal("51000"), Decimal("50200"), 3, 4)
    decision = check_circuit_breakers(state, LIMITS)
    assert not decision.allowed
    assert not decision.trip_kill_switch


def test_max_daily_trades_pauses_without_kill_switch():
    state = AccountRiskState(Decimal("50000"), Decimal("51000"), Decimal("50200"), 0, 8)
    decision = check_circuit_breakers(state, LIMITS)
    assert not decision.allowed
    assert not decision.trip_kill_switch
