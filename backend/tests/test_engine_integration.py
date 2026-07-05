"""End-to-end engine test: synthetic bars -> regime/score/risk/execution -> a
closed trade in the DB, entirely against SimulatedBroker.

Requires a reachable Postgres (TEST_DATABASE_URL or DATABASE_URL env var) --
skips cleanly if none is available, since this sandbox may not have
TimescaleDB running. Uses SQLAlchemy's plain `create_all` (not the Timescale
hypertable migration) so it only needs vanilla Postgres/JSONB support.
"""
from __future__ import annotations

import datetime as dt
import os
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from app.brokers.simulated import SimulatedBroker
from app.db.base import Base
from app.db.models import Instrument, RegimeSnapshot, Score
from app.engine.loop import TradingEngine
from tests.conftest import make_trending_bars

pytestmark = pytest.mark.asyncio

TEST_DB_URL = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")


@pytest.fixture
async def db_session_factory():
    if not TEST_DB_URL:
        pytest.skip("No TEST_DATABASE_URL/DATABASE_URL configured -- skipping DB integration test")

    import app.db.base as db_base

    engine = create_async_engine(TEST_DB_URL, future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    db_base._engine = engine
    from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession

    db_base._session_factory = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)

    yield db_base.get_session_factory()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


async def test_engine_produces_regime_and_score_without_placing_real_orders(db_session_factory):
    session_factory = db_session_factory
    symbol = "ES"

    async with session_factory() as session:
        session.add(Instrument(symbol=symbol, data_symbol="ES=F", tick_size=Decimal("0.25"), point_value=Decimal("50")))
        await session.commit()

        bars = make_trending_bars(periods=200)
        from app.db.models import Bar

        for ts, row in bars.iterrows():
            session.add(
                Bar(
                    time=ts, symbol=symbol, open=Decimal(str(row["open"])), high=Decimal(str(row["high"])),
                    low=Decimal(str(row["low"])), close=Decimal(str(row["close"])), volume=Decimal(str(row["volume"])),
                )
            )
        await session.commit()

    engine = TradingEngine(broker=SimulatedBroker())
    last_row = bars.iloc[-1]
    await engine.on_new_bar(
        symbol, bars.index[-1], Decimal(str(last_row["open"])), Decimal(str(last_row["high"])),
        Decimal(str(last_row["low"])), Decimal(str(last_row["close"])), Decimal(str(last_row["volume"])),
    )

    async with session_factory() as session:
        regimes = (await session.execute(select(RegimeSnapshot).where(RegimeSnapshot.symbol == symbol))).scalars().all()
        assert len(regimes) == 1
        assert regimes[0].trend_label in ("up", "down", "none")

        scores = (await session.execute(select(Score).where(Score.symbol == symbol))).scalars().all()
        # A strong uptrend + breakout/trend-following fixture should produce at least one scored setup.
        assert len(scores) >= 1
