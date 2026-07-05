"""Broker abstraction layer.

Every execution path in Terra Trade -- paper or live -- goes through this
interface. Strategy/risk/execution code never talks to a specific broker
directly, so swapping SimulatedBroker for ProjectXGatewayBroker (or any future
broker) requires no changes above this layer.
"""
from __future__ import annotations

import datetime as dt
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum


class OrderSide(StrEnum):
    BUY = "buy"
    SELL = "sell"


class OrderType(StrEnum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    TRAILING_STOP = "trailing_stop"


@dataclass(frozen=True)
class HistoricalBar:
    time: dt.datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


@dataclass(frozen=True)
class BrokerAccount:
    account_id: str
    name: str
    balance: Decimal
    equity: Decimal


@dataclass(frozen=True)
class BrokerPosition:
    account_id: str
    symbol: str
    side: OrderSide
    quantity: int
    avg_price: Decimal
    unrealized_pnl: Decimal


@dataclass(frozen=True)
class BrokerOrder:
    broker_order_id: str
    account_id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: int
    status: str
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None


@dataclass(frozen=True)
class OrderRequest:
    account_id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: int
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    trail_ticks: int | None = None
    stop_loss_price: Decimal | None = None
    take_profit_price: Decimal | None = None
    custom_tag: str | None = None
    # Needed by SimulatedBroker to compute a realistic fill; ignored by real brokers.
    reference_price: Decimal | None = None


@dataclass(frozen=True)
class OrderResult:
    broker_order_id: str
    status: str  # filled|pending|rejected
    filled_price: Decimal | None = None
    filled_at: dt.datetime | None = None
    error: str | None = None


@dataclass
class ClosedSimTrade:
    """Emitted by SimulatedBroker when a bar triggers a stop/target/trailing exit."""

    symbol: str
    account_id: str
    exit_time: dt.datetime
    exit_price: Decimal
    exit_reason: str
    custom_tag: str | None = None


AccountUpdateHandler = Callable[[dict], Awaitable[None]]
MarketDataHandler = Callable[[dict], Awaitable[None]]


class BrokerClient(ABC):
    """Common interface implemented by SimulatedBroker and ProjectXGatewayBroker."""

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @abstractmethod
    async def get_accounts(self) -> list[BrokerAccount]: ...

    @abstractmethod
    async def get_positions(self, account_id: str) -> list[BrokerPosition]: ...

    @abstractmethod
    async def get_open_orders(self, account_id: str) -> list[BrokerOrder]: ...

    @abstractmethod
    async def place_order(self, request: OrderRequest) -> OrderResult: ...

    @abstractmethod
    async def cancel_order(self, account_id: str, broker_order_id: str) -> bool: ...

    @abstractmethod
    async def get_historical_bars(
        self,
        symbol: str,
        start: dt.datetime,
        end: dt.datetime,
        unit_minutes: int = 1,
        limit: int = 20_000,
    ) -> list[HistoricalBar]: ...

    async def start_market_stream(self, symbols: list[str], handler: MarketDataHandler) -> None:
        """Optional: real brokers push live quotes/trades to `handler`. Default no-op."""
        return None

    async def start_account_stream(self, account_id: str, handler: AccountUpdateHandler) -> None:
        """Optional: real brokers push order/position/trade updates to `handler`. Default no-op."""
        return None
