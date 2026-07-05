"""Paper-trading broker: realistic simulated fills against reference prices supplied
by the caller (the engine, driven by real/historical bars), with a simple slippage
model and self-contained stop/target/trailing-stop bracket tracking.

This is the default broker for Phase 0/1/2 -- it never talks to a network.
"""
from __future__ import annotations

import datetime as dt
import itertools
from dataclasses import dataclass
from decimal import Decimal

from app.brokers.base import (
    BrokerAccount,
    BrokerClient,
    BrokerOrder,
    BrokerPosition,
    ClosedSimTrade,
    HistoricalBar,
    OrderRequest,
    OrderResult,
    OrderSide,
    OrderType,
)
from app.core.logging import get_logger

logger = get_logger(__name__)

_order_id_counter = itertools.count(1)

DEFAULT_SLIPPAGE_TICKS = 1


@dataclass
class SimBracket:
    """A resting stop/target/trailing-stop bracket for one simulated position."""

    account_id: str
    symbol: str
    side: OrderSide
    quantity: int
    entry_price: Decimal
    stop_price: Decimal
    take_profit_price: Decimal | None
    trail_ticks: int | None
    tick_size: Decimal
    custom_tag: str | None = None
    highest_favorable: Decimal | None = None  # for trailing computation


class SimulatedBroker(BrokerClient):
    def __init__(self, starting_balance: Decimal = Decimal("50000")) -> None:
        self._balance = starting_balance
        self._equity = starting_balance
        self._positions: dict[tuple[str, str], BrokerPosition] = {}
        self._brackets: dict[tuple[str, str], SimBracket] = {}
        self._orders: dict[str, BrokerOrder] = {}

    async def connect(self) -> None:
        logger.info("simulated_broker.connect")

    async def disconnect(self) -> None:
        logger.info("simulated_broker.disconnect")

    async def get_accounts(self) -> list[BrokerAccount]:
        return [BrokerAccount(account_id="sim-1", name="Simulated", balance=self._balance, equity=self._equity)]

    async def get_positions(self, account_id: str) -> list[BrokerPosition]:
        return [p for (acc, _), p in self._positions.items() if acc == account_id]

    async def get_open_orders(self, account_id: str) -> list[BrokerOrder]:
        return [o for o in self._orders.values() if o.account_id == account_id and o.status == "pending"]

    async def place_order(self, request: OrderRequest) -> OrderResult:
        if request.reference_price is None:
            return OrderResult(broker_order_id="", status="rejected", error="reference_price required for simulated fills")

        order_id = f"SIM-{next(_order_id_counter)}"
        tick_size = Decimal("0.25")
        slippage = tick_size * DEFAULT_SLIPPAGE_TICKS
        fill_price = (
            request.reference_price + slippage if request.side == OrderSide.BUY else request.reference_price - slippage
        )
        now = dt.datetime.now(dt.timezone.utc)

        key = (request.account_id, request.symbol)
        self._positions[key] = BrokerPosition(
            account_id=request.account_id,
            symbol=request.symbol,
            side=request.side,
            quantity=request.quantity,
            avg_price=fill_price,
            unrealized_pnl=Decimal("0"),
        )
        if request.stop_loss_price is not None:
            self._brackets[key] = SimBracket(
                account_id=request.account_id,
                symbol=request.symbol,
                side=request.side,
                quantity=request.quantity,
                entry_price=fill_price,
                stop_price=request.stop_loss_price,
                take_profit_price=request.take_profit_price,
                trail_ticks=request.trail_ticks,
                tick_size=tick_size,
                custom_tag=request.custom_tag,
                highest_favorable=fill_price,
            )

        self._orders[order_id] = BrokerOrder(
            broker_order_id=order_id,
            account_id=request.account_id,
            symbol=request.symbol,
            side=request.side,
            order_type=request.order_type,
            quantity=request.quantity,
            status="filled",
        )
        logger.info("simulated_broker.fill", order_id=order_id, symbol=request.symbol, price=str(fill_price))
        return OrderResult(broker_order_id=order_id, status="filled", filled_price=fill_price, filled_at=now)

    async def cancel_order(self, account_id: str, broker_order_id: str) -> bool:
        order = self._orders.get(broker_order_id)
        if order is None or order.status != "pending":
            return False
        self._orders[broker_order_id] = BrokerOrder(**{**order.__dict__, "status": "cancelled"})
        return True

    async def close_position(self, account_id: str, symbol: str, exit_price: Decimal) -> Decimal:
        """Force-close (kill switch / manual). Returns realized pnl in points."""
        key = (account_id, symbol)
        position = self._positions.pop(key, None)
        self._brackets.pop(key, None)
        if position is None:
            return Decimal("0")
        direction = 1 if position.side == OrderSide.BUY else -1
        return (exit_price - position.avg_price) * direction

    def update_trailing_stop(self, account_id: str, symbol: str, current_price: Decimal) -> None:
        """Ratchet a chandelier/structure trailing stop forward. Called every bar."""
        bracket = self._brackets.get((account_id, symbol))
        if bracket is None or bracket.trail_ticks is None:
            return
        trail_distance = bracket.tick_size * bracket.trail_ticks
        if bracket.side == OrderSide.BUY:
            bracket.highest_favorable = max(bracket.highest_favorable or current_price, current_price)
            new_stop = bracket.highest_favorable - trail_distance
            if new_stop > bracket.stop_price:
                bracket.stop_price = new_stop
        else:
            bracket.highest_favorable = min(bracket.highest_favorable or current_price, current_price)
            new_stop = bracket.highest_favorable + trail_distance
            if new_stop < bracket.stop_price:
                bracket.stop_price = new_stop

    def evaluate_bar(self, account_id: str, symbol: str, high: Decimal, low: Decimal, bar_time: dt.datetime) -> ClosedSimTrade | None:
        """Check whether this bar's range triggered the resting stop or target."""
        key = (account_id, symbol)
        bracket = self._brackets.get(key)
        if bracket is None:
            return None

        if bracket.side == OrderSide.BUY:
            hit_stop = low <= bracket.stop_price
            hit_target = bracket.take_profit_price is not None and high >= bracket.take_profit_price
        else:
            hit_stop = high >= bracket.stop_price
            hit_target = bracket.take_profit_price is not None and low <= bracket.take_profit_price

        if not (hit_stop or hit_target):
            return None

        # Conservative: if both could have hit intrabar, assume the adverse one (stop) triggered first.
        exit_reason = "stop" if hit_stop else "target"
        exit_price = bracket.stop_price if hit_stop else bracket.take_profit_price
        self._positions.pop(key, None)
        self._brackets.pop(key, None)
        return ClosedSimTrade(
            symbol=symbol,
            account_id=account_id,
            exit_time=bar_time,
            exit_price=exit_price,
            exit_reason=exit_reason,
            custom_tag=bracket.custom_tag,
        )

    async def get_historical_bars(
        self,
        symbol: str,
        start: dt.datetime,
        end: dt.datetime,
        unit_minutes: int = 1,
        limit: int = 20_000,
    ) -> list[HistoricalBar]:
        raise NotImplementedError("SimulatedBroker has no market data of its own; use app.market_data instead")
