"""Broker adapter for Topstep's ProjectX Gateway API.

Built directly against the documented REST + SignalR spec at
https://gateway.docs.projectx.com/ (confirmed endpoints as of 2026-07):

- Auth:      POST {base}/api/Auth/loginKey            {userName, apiKey} -> {token}
- Bars:      POST {base}/api/History/retrieveBars      {contractId, live, startTime, endTime,
                                                          unit, unitNumber, limit, includePartialBar}
- Place:     POST {base}/api/Order/place               {accountId, contractId, type, side, size,
                                                          limitPrice?, stopPrice?, trailPrice?,
                                                          customTag?, stopLossBracket?, takeProfitBracket?}
- Orders:    POST {base}/api/Order/searchOpen           {accountId}
- Positions: POST {base}/api/Position/searchOpen        {accountId}
- Realtime:  wss://{rtc}/hubs/user?access_token=JWT     events: GatewayUserAccount/Order/Position/Trade
             wss://{rtc}/hubs/market?access_token=JWT   events: GatewayQuote/Trade/Depth

This class can only be integration-tested once real ProjectX Gateway credentials
are configured (`PROJECTX_USERNAME` / `PROJECTX_API_KEY`) -- until then it is
exercised by unit tests with a mocked HTTP transport. The engine defaults to
SimulatedBroker; this adapter is only used once TRADING_MODE reaches `live` AND
BROKER_KIND=projectx is explicitly configured.
"""
from __future__ import annotations

import asyncio
import datetime as dt
from decimal import Decimal
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.brokers.base import (
    AccountUpdateHandler,
    BrokerAccount,
    BrokerClient,
    BrokerOrder,
    BrokerPosition,
    HistoricalBar,
    MarketDataHandler,
    OrderRequest,
    OrderResult,
    OrderSide,
    OrderType,
)
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# ProjectX Gateway enums (see class docstring for source).
_ORDER_TYPE_MAP = {
    OrderType.LIMIT: 1,
    OrderType.MARKET: 2,
    OrderType.STOP: 4,
    OrderType.TRAILING_STOP: 5,
}
_SIDE_MAP = {OrderSide.BUY: 0, OrderSide.SELL: 1}
_BAR_UNIT_MINUTE = 2  # 1=Second,2=Minute,3=Hour,4=Day,5=Week,6=Month


class ProjectXAuthError(RuntimeError):
    pass


class ProjectXGatewayBroker(BrokerClient):
    def __init__(self) -> None:
        settings = get_settings()
        self._base_url = settings.projectx_base_url.rstrip("/")
        self._rtc_url = settings.projectx_rtc_url.rstrip("/")
        self._username = settings.projectx_username
        self._api_key = settings.projectx_api_key
        self._token: str | None = None
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=15.0)
        self._user_hub: Any | None = None
        self._market_hub: Any | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- auth -----------------------------------------------------------
    async def connect(self) -> None:
        if not self._username or not self._api_key:
            raise ProjectXAuthError(
                "PROJECTX_USERNAME / PROJECTX_API_KEY are not configured; cannot connect to ProjectX Gateway"
            )
        self._loop = asyncio.get_running_loop()
        resp = await self._client.post(
            "/api/Auth/loginKey", json={"userName": self._username, "apiKey": self._api_key}
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise ProjectXAuthError(f"ProjectX login failed: {data.get('errorMessage')}")
        self._token = data["token"]
        self._client.headers["Authorization"] = f"Bearer {self._token}"
        logger.info("projectx.connected", username=self._username)

    async def disconnect(self) -> None:
        if self._user_hub is not None:
            self._user_hub.stop()
        if self._market_hub is not None:
            self._market_hub.stop()
        await self._client.aclose()

    def _require_token(self) -> None:
        if self._token is None:
            raise ProjectXAuthError("Not connected -- call connect() first")

    # -- REST -------------------------------------------------------------
    @retry(
        retry=retry_if_exception_type(httpx.TransportError),
        wait=wait_exponential(multiplier=0.5, max=8),
        stop=stop_after_attempt(3),
    )
    async def _post(self, path: str, payload: dict) -> dict:
        self._require_token()
        resp = await self._client.post(path, json=payload)
        resp.raise_for_status()
        return resp.json()

    async def get_accounts(self) -> list[BrokerAccount]:
        data = await self._post("/api/Account/search", {"onlyActiveAccounts": True})
        return [
            BrokerAccount(
                account_id=str(a["id"]),
                name=a.get("name", str(a["id"])),
                balance=Decimal(str(a.get("balance", 0))),
                equity=Decimal(str(a.get("equity", a.get("balance", 0)))),
            )
            for a in data.get("accounts", [])
        ]

    async def get_positions(self, account_id: str) -> list[BrokerPosition]:
        data = await self._post("/api/Position/searchOpen", {"accountId": int(account_id)})
        out = []
        for p in data.get("positions", []):
            side = OrderSide.BUY if p.get("size", 0) >= 0 else OrderSide.SELL
            out.append(
                BrokerPosition(
                    account_id=account_id,
                    symbol=p["contractId"],
                    side=side,
                    quantity=abs(p.get("size", 0)),
                    avg_price=Decimal(str(p.get("averagePrice", 0))),
                    unrealized_pnl=Decimal(str(p.get("unrealizedPnl", 0))),
                )
            )
        return out

    async def get_open_orders(self, account_id: str) -> list[BrokerOrder]:
        data = await self._post("/api/Order/searchOpen", {"accountId": int(account_id)})
        out = []
        for o in data.get("orders", []):
            out.append(
                BrokerOrder(
                    broker_order_id=str(o["id"]),
                    account_id=account_id,
                    symbol=o["contractId"],
                    side=OrderSide.BUY if o.get("side") == 0 else OrderSide.SELL,
                    order_type=OrderType.MARKET,
                    quantity=o.get("size", 0),
                    status=o.get("status", "pending"),
                    limit_price=Decimal(str(o["limitPrice"])) if o.get("limitPrice") is not None else None,
                    stop_price=Decimal(str(o["stopPrice"])) if o.get("stopPrice") is not None else None,
                )
            )
        return out

    async def place_order(self, request: OrderRequest) -> OrderResult:
        payload: dict[str, Any] = {
            "accountId": int(request.account_id),
            "contractId": request.symbol,
            "type": _ORDER_TYPE_MAP[request.order_type],
            "side": _SIDE_MAP[request.side],
            "size": request.quantity,
        }
        if request.limit_price is not None:
            payload["limitPrice"] = float(request.limit_price)
        if request.stop_price is not None:
            payload["stopPrice"] = float(request.stop_price)
        if request.custom_tag:
            payload["customTag"] = request.custom_tag
        # Bracket orders are expressed as tick offsets by the gateway, not absolute
        # prices -- the caller (execution engine) is responsible for converting
        # stop_loss_price/take_profit_price into tick distances before this point
        # is reached in a live-mode build-out; left as an explicit TODO because it
        # requires the live instrument's tick_size, which this adapter doesn't own.

        try:
            data = await self._post("/api/Order/place", payload)
        except httpx.HTTPStatusError as exc:
            return OrderResult(broker_order_id="", status="rejected", error=str(exc))

        if not data.get("success"):
            return OrderResult(broker_order_id="", status="rejected", error=data.get("errorMessage"))
        return OrderResult(broker_order_id=str(data["orderId"]), status="pending")

    async def cancel_order(self, account_id: str, broker_order_id: str) -> bool:
        data = await self._post("/api/Order/cancel", {"accountId": int(account_id), "orderId": int(broker_order_id)})
        return bool(data.get("success"))

    async def get_trade_history(
        self, account_id: str, start: dt.datetime, end: dt.datetime | None = None
    ) -> list[dict]:
        """Historical fills for backfilling the local `trades` table.

        A null `profitAndLoss` on a returned row means it's a half-turn trade
        (entry without a matching exit yet, or vice versa) -- pair rows by
        `orderId`/contractId when reconstructing round-trip trades.
        """
        payload: dict[str, Any] = {"accountId": int(account_id), "startTimestamp": start.isoformat()}
        if end is not None:
            payload["endTimestamp"] = end.isoformat()
        data = await self._post("/api/Trade/search", payload)
        return data.get("trades", [])

    async def get_historical_bars(
        self,
        symbol: str,
        start: dt.datetime,
        end: dt.datetime,
        unit_minutes: int = 1,
        limit: int = 20_000,
    ) -> list[HistoricalBar]:
        data = await self._post(
            "/api/History/retrieveBars",
            {
                "contractId": symbol,
                "live": False,
                "startTime": start.isoformat(),
                "endTime": end.isoformat(),
                "unit": _BAR_UNIT_MINUTE,
                "unitNumber": unit_minutes,
                "limit": limit,
                "includePartialBar": False,
            },
        )
        return [
            HistoricalBar(
                time=dt.datetime.fromisoformat(b["t"]),
                open=Decimal(str(b["o"])),
                high=Decimal(str(b["h"])),
                low=Decimal(str(b["l"])),
                close=Decimal(str(b["c"])),
                volume=Decimal(str(b.get("v", 0))),
            )
            for b in data.get("bars", [])
        ]

    # -- Realtime (SignalR) -----------------------------------------------
    def _build_hub(self, hub_path: str):
        from signalrcore.hub_connection_builder import HubConnectionBuilder

        self._require_token()
        url = f"{self._rtc_url}/hubs/{hub_path}?access_token={self._token}"
        return (
            HubConnectionBuilder()
            .with_url(url, options={"skip_negotiation": True})
            .with_automatic_reconnect({"type": "interval", "keep_alive_interval": 10, "intervals": [1, 3, 5, 10, 15]})
            .build()
        )

    async def start_market_stream(self, symbols: list[str], handler: MarketDataHandler) -> None:
        loop = asyncio.get_running_loop()
        hub = self._build_hub("market")

        def _on_event(event_name: str):
            def _callback(args: list) -> None:
                payload = {"event": event_name, "data": args[0] if args else None}
                asyncio.run_coroutine_threadsafe(handler(payload), loop)

            return _callback

        for event in ("GatewayQuote", "GatewayTrade", "GatewayDepth"):
            hub.on(event, _on_event(event))
        hub.start()
        for symbol in symbols:
            hub.send("SubscribeContractQuotes", [symbol])
            hub.send("SubscribeContractTrades", [symbol])
        self._market_hub = hub

    async def start_account_stream(self, account_id: str, handler: AccountUpdateHandler) -> None:
        loop = asyncio.get_running_loop()
        hub = self._build_hub("user")

        def _on_event(event_name: str):
            def _callback(args: list) -> None:
                payload = {"event": event_name, "data": args[0] if args else None}
                asyncio.run_coroutine_threadsafe(handler(payload), loop)

            return _callback

        for event in ("GatewayUserAccount", "GatewayUserOrder", "GatewayUserPosition", "GatewayUserTrade"):
            hub.on(event, _on_event(event))
        hub.start()
        hub.send("SubscribeAccounts", [])
        self._user_hub = hub
