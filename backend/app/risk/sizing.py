"""Fixed-fractional position sizing.

Every trade's size is derived from the stop-loss distance, never from a
target win rate or a fixed contract count -- this is the concrete mechanism
behind "never assume losses are impossible": the position is sized so that if
the stop is hit, the loss equals (at most) the configured per-trade risk
percentage of account equity.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class SizingResult:
    quantity: int
    risk_amount: Decimal
    stop_distance_points: Decimal
    capped_by_max_position: bool
    reason: str


def compute_position_size(
    account_equity: Decimal,
    per_trade_risk_pct: Decimal,
    stop_distance_points: Decimal,
    point_value: Decimal,
    max_position_size: int,
) -> SizingResult:
    if stop_distance_points <= 0:
        return SizingResult(0, Decimal("0"), stop_distance_points, False, "no stop distance provided -- no stop, no trade")

    risk_amount = account_equity * (per_trade_risk_pct / Decimal("100"))
    risk_per_contract = stop_distance_points * point_value
    if risk_per_contract <= 0:
        return SizingResult(0, risk_amount, stop_distance_points, False, "invalid point value / stop distance")

    raw_quantity = int(risk_amount / risk_per_contract)
    capped = raw_quantity > max_position_size
    quantity = min(raw_quantity, max_position_size)

    if quantity <= 0:
        return SizingResult(
            0, risk_amount, stop_distance_points, capped,
            f"stop distance too wide for {per_trade_risk_pct}% risk on this account size -- sized to 0 contracts",
        )

    reason = (
        f"risking {per_trade_risk_pct}% of equity (${risk_amount:.2f}) over a {stop_distance_points} point stop "
        f"sizes to {raw_quantity} contract(s)"
    )
    if capped:
        reason += f", capped to the account's max position size of {max_position_size}"
    return SizingResult(quantity, risk_amount, stop_distance_points, capped, reason)
