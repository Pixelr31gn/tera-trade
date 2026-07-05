from decimal import Decimal

from app.risk.sizing import compute_position_size


def test_position_size_scales_with_risk_and_stop_distance():
    result = compute_position_size(
        account_equity=Decimal("50000"),
        per_trade_risk_pct=Decimal("1"),
        stop_distance_points=Decimal("4"),
        point_value=Decimal("50"),
        max_position_size=10,
    )
    # risk_amount = 500; risk_per_contract = 4*50=200 -> 2 contracts
    assert result.quantity == 2
    assert not result.capped_by_max_position


def test_position_size_capped_by_max_position():
    result = compute_position_size(
        account_equity=Decimal("50000"),
        per_trade_risk_pct=Decimal("5"),
        stop_distance_points=Decimal("1"),
        point_value=Decimal("50"),
        max_position_size=3,
    )
    assert result.quantity == 3
    assert result.capped_by_max_position


def test_position_size_zero_when_no_stop_distance():
    result = compute_position_size(
        account_equity=Decimal("50000"), per_trade_risk_pct=Decimal("1"),
        stop_distance_points=Decimal("0"), point_value=Decimal("50"), max_position_size=10,
    )
    assert result.quantity == 0
    assert "no stop distance" in result.reason


def test_position_size_zero_when_stop_too_wide():
    result = compute_position_size(
        account_equity=Decimal("1000"), per_trade_risk_pct=Decimal("0.5"),
        stop_distance_points=Decimal("100"), point_value=Decimal("50"), max_position_size=10,
    )
    assert result.quantity == 0
