"""Stop-loss, take-profit, and trailing-stop rules.

Every position must have a stop before it can be opened -- enforced here and
again in `RiskEngine.assess_new_trade`, defense in depth. The initial stop is
whichever is *tighter* of a structure-based swing level and an ATR multiple,
so a strategy can't accidentally take on more risk than the ATR model implies
just because the last swing point was far away.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class StopPlan:
    stop_price: Decimal
    stop_distance_points: Decimal
    basis: str  # "structure" | "atr"
    take_profit_price: Decimal | None
    trail_ticks: int


def compute_initial_stop(
    entry_price: Decimal,
    side: str,
    atr_value: Decimal,
    structure_swing_price: Decimal | None,
    atr_multiplier: Decimal = Decimal("1.5"),
    take_profit_r_multiple: Decimal = Decimal("2.0"),
    tick_size: Decimal = Decimal("0.25"),
    chandelier_atr_multiplier: Decimal = Decimal("3.0"),
) -> StopPlan:
    atr_stop_distance = atr_value * atr_multiplier
    atr_stop_price = entry_price - atr_stop_distance if side == "long" else entry_price + atr_stop_distance

    if structure_swing_price is not None:
        structure_distance = abs(entry_price - structure_swing_price)
        # Tighter of the two -- whichever implies a smaller stop distance.
        if structure_distance > 0 and structure_distance < atr_stop_distance:
            stop_price, distance, basis = structure_swing_price, structure_distance, "structure"
        else:
            stop_price, distance, basis = atr_stop_price, atr_stop_distance, "atr"
    else:
        stop_price, distance, basis = atr_stop_price, atr_stop_distance, "atr"

    take_profit_distance = distance * take_profit_r_multiple
    take_profit_price = entry_price + take_profit_distance if side == "long" else entry_price - take_profit_distance

    trail_distance = atr_value * chandelier_atr_multiplier
    trail_ticks = max(1, int(trail_distance / tick_size)) if tick_size > 0 else 1

    return StopPlan(
        stop_price=stop_price,
        stop_distance_points=distance,
        basis=basis,
        take_profit_price=take_profit_price,
        trail_ticks=trail_ticks,
    )
