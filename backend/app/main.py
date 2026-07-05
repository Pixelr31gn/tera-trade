"""Terra Trade FastAPI application entrypoint.

Boots the API, the websocket broadcaster, and the live bar polling + trading
engine loop as a background asyncio task. The engine always starts in
whatever `system_state.mode` was last persisted (ANALYSIS_ONLY on a fresh
database), so a restart never silently resumes paper/live trading without
that having been the last explicitly-set mode.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routers import accounts, backfill, news, performance, positions, regime, scores, system, trades
from app.api.ws import router as ws_router
from app.api.ws_manager import manager
from app.brokers import get_broker
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.db.base import session_scope
from app.engine.loop import TradingEngine
from app.market_data.backfill import ensure_instruments_seeded
from app.market_data.instruments import DEFAULT_INSTRUMENTS
from app.market_data.live import LiveBarPoller

logger = get_logger(__name__)

_poller: LiveBarPoller | None = None
_poller_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)

    async with session_scope() as session:
        await ensure_instruments_seeded(session)

    broker = get_broker(settings.broker_kind.value)
    await broker.connect()
    engine = TradingEngine(broker=broker, event_sink=manager.broadcast)

    global _poller, _poller_task
    _poller = LiveBarPoller(on_new_bar=engine.on_new_bar, poll_seconds=settings.engine_poll_seconds, instruments=DEFAULT_INSTRUMENTS)
    _poller_task = asyncio.create_task(_poller.run_forever())
    logger.info("terra_trade.started", mode=settings.trading_mode.value, broker=settings.broker_kind.value)

    yield

    if _poller is not None:
        _poller.stop()
    if _poller_task is not None:
        await asyncio.wait([_poller_task], timeout=5)
    await broker.disconnect()
    logger.info("terra_trade.stopped")


app = FastAPI(title="Terra Trade", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(system.router)
app.include_router(accounts.router)
app.include_router(positions.router)
app.include_router(scores.router)
app.include_router(trades.router)
app.include_router(performance.router)
app.include_router(regime.router)
app.include_router(news.router)
app.include_router(backfill.router)
app.include_router(ws_router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
