"""Live bar pipeline for the free-data path.

Yahoo Finance has no real push/streaming API, so "live" here means polling for
the latest completed 1-minute bar on an interval and treating each new bar as
a tick for the engine loop. This is what "real-time" honestly means without a
paid market-data vendor or a connected ProjectX Gateway account; once the user
has ProjectX credentials, `ProjectXGatewayBroker.start_market_stream()` should
be used instead for true push-based quotes.
"""
from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable
from decimal import Decimal

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.logging import get_logger
from app.db.base import session_scope
from app.db.models import Bar
from app.market_data.backfill import _download_sync
from app.market_data.instruments import DEFAULT_INSTRUMENTS, InstrumentSpec

logger = get_logger(__name__)

NewBarHandler = Callable[[str, dt.datetime, Decimal, Decimal, Decimal, Decimal, Decimal], Awaitable[None]]


class LiveBarPoller:
    def __init__(self, on_new_bar: NewBarHandler, poll_seconds: float = 30.0, instruments: list[InstrumentSpec] | None = None) -> None:
        self._on_new_bar = on_new_bar
        self._poll_seconds = poll_seconds
        self._instruments = instruments or DEFAULT_INSTRUMENTS
        self._last_seen: dict[str, dt.datetime] = {}
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run_forever(self) -> None:
        logger.info("live_bar_poller.start", symbols=[i.symbol for i in self._instruments], poll_seconds=self._poll_seconds)
        while not self._stop.is_set():
            for spec in self._instruments:
                try:
                    await self._poll_once(spec)
                except Exception:
                    logger.exception("live_bar_poller.poll_failed", symbol=spec.symbol)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._poll_seconds)
            except TimeoutError:
                pass

    async def _poll_once(self, spec: InstrumentSpec) -> None:
        df = await asyncio.to_thread(_download_sync, spec.data_symbol, "1d", "1m")
        if df.empty:
            return
        last_idx = df.index[-1]
        last_time = last_idx.to_pydatetime()
        if self._last_seen.get(spec.symbol) == last_time:
            return  # no new completed bar yet
        self._last_seen[spec.symbol] = last_time

        row = df.iloc[-1]
        o, h, l, c, v = (
            Decimal(str(round(float(row["Open"]), 8))),
            Decimal(str(round(float(row["High"]), 8))),
            Decimal(str(round(float(row["Low"]), 8))),
            Decimal(str(round(float(row["Close"]), 8))),
            Decimal(str(float(row["Volume"] or 0))),
        )

        async with session_scope() as session:
            stmt = pg_insert(Bar).values(
                time=last_time, symbol=spec.symbol, open=o, high=h, low=l, close=c, volume=v
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=[Bar.time, Bar.symbol],
                set_={"open": stmt.excluded.open, "high": stmt.excluded.high, "low": stmt.excluded.low,
                      "close": stmt.excluded.close, "volume": stmt.excluded.volume},
            )
            await session.execute(stmt)

        await self._on_new_bar(spec.symbol, last_time, o, h, l, c, v)
