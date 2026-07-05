from decimal import Decimal

from app.risk.stops import compute_initial_stop


def test_stop_uses_tighter_of_structure_and_atr_long():
    plan = compute_initial_stop(
        entry_price=Decimal("100"), side="long", atr_value=Decimal("2"),
        structure_swing_price=Decimal("98.5"),  # 1.5 pts away, tighter than ATR*1.5=3
        tick_size=Decimal("0.25"),
    )
    assert plan.basis == "structure"
    assert plan.stop_price == Decimal("98.5")
    assert plan.take_profit_price > Decimal("100")


def test_stop_falls_back_to_atr_when_structure_is_wider():
    plan = compute_initial_stop(
        entry_price=Decimal("100"), side="long", atr_value=Decimal("2"),
        structure_swing_price=Decimal("90"),  # far away
        tick_size=Decimal("0.25"),
    )
    assert plan.basis == "atr"
    assert plan.stop_price == Decimal("100") - Decimal("2") * Decimal("1.5")


def test_stop_short_side_direction():
    plan = compute_initial_stop(
        entry_price=Decimal("100"), side="short", atr_value=Decimal("2"),
        structure_swing_price=None, tick_size=Decimal("0.25"),
    )
    assert plan.stop_price > Decimal("100")
    assert plan.take_profit_price < Decimal("100")


def test_trail_ticks_derived_from_atr_and_tick_size():
    plan = compute_initial_stop(
        entry_price=Decimal("100"), side="long", atr_value=Decimal("1"),
        structure_swing_price=None, tick_size=Decimal("0.25"), chandelier_atr_multiplier=Decimal("3"),
    )
    assert plan.trail_ticks == 12  # 1 * 3 / 0.25
