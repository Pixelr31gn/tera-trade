"""Historical data ingestion from the free Yahoo Finance vendor.

Yahoo's public data has real constraints that shape this module's design:
- 1-minute bars are only available for the trailing ~7 days.
- Daily bars are available for the instrument's full history.
So: `backfill_daily()` pulls 1+ year of daily bars (the honest way to satisfy
"a year of historical price data" for free) into `bars_daily`, and
`backfill_recent_intraday()` seeds `bars_1m` with whatever 1-minute history
Yahoo will give us so the live pipeline has continuity when it starts polling.
"""
from __future__ import annotations

import asyncio
import datetime as dt
from decimal import Decimal

import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.models import Bar, DailyBar, Instrument
from app.market_data.instruments import DEFAULT_INSTRUMENTS, InstrumentSpec

logger = get_logger(__name__)

MAX_INTRADAY_LOOKBACK_DAYS = 7


async def ensure_instruments_seeded(session: AsyncSession) -> None:
    existing = {row.symbol for row in (await session.execute(select(Instrument))).scalars().all()}
    for spec in DEFAULT_INSTRUMENTS:
        if spec.symbol in existing:
            continue
        session.add(
            Instrument(
                symbol=spec.symbol,
                data_symbol=spec.data_symbol,
                exchange=spec.exchange,
                tick_size=spec.tick_size,
                point_value=spec.point_value,
            )
        )
    await session.commit()


def _download_sync(data_symbol: str, period: str, interval: str) -> pd.DataFrame:
    import yfinance as yf

    df = yf.Ticker(data_symbol).history(period=period, interval=interval, auto_adjust=False)
    return df


async def backfill_daily(session: AsyncSession, spec: InstrumentSpec, days: int) -> int:
    period = f"{max(days, 30)}d"
    df = await asyncio.to_thread(_download_sync, spec.data_symbol, period, "1d")
    if df.empty:
        logger.warning("backfill.daily.empty", symbol=spec.symbol)
        return 0

    rows = [
        {
            "date": idx.date(),
            "symbol": spec.symbol,
            "open": Decimal(str(round(float(row["Open"]), 8))),
            "high": Decimal(str(round(float(row["High"]), 8))),
            "low": Decimal(str(round(float(row["Low"]), 8))),
            "close": Decimal(str(round(float(row["Close"]), 8))),
            "volume": Decimal(str(float(row["Volume"] or 0))),
        }
        for idx, row in df.iterrows()
    ]

    stmt = pg_insert(DailyBar).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=[DailyBar.date, DailyBar.symbol],
        set_={"open": stmt.excluded.open, "high": stmt.excluded.high, "low": stmt.excluded.low,
              "close": stmt.excluded.close, "volume": stmt.excluded.volume},
    )
    await session.execute(stmt)
    await session.commit()
    logger.info("backfill.daily.done", symbol=spec.symbol, rows=len(rows))
    return len(rows)


async def backfill_recent_intraday(session: AsyncSession, spec: InstrumentSpec) -> int:
    df = await asyncio.to_thread(_download_sync, spec.data_symbol, f"{MAX_INTRADAY_LOOKBACK_DAYS}d", "1m")
    if df.empty:
        logger.warning("backfill.intraday.empty", symbol=spec.symbol)
        return 0

    rows = [
        {
            "time": idx.to_pydatetime(),
            "symbol": spec.symbol,
            "open": Decimal(str(round(float(row["Open"]), 8))),
            "high": Decimal(str(round(float(row["High"]), 8))),
            "low": Decimal(str(round(float(row["Low"]), 8))),
            "close": Decimal(str(round(float(row["Close"]), 8))),
            "volume": Decimal(str(float(row["Volume"] or 0))),
        }
        for idx, row in df.iterrows()
    ]

    stmt = pg_insert(Bar).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Bar.time, Bar.symbol],
        set_={"open": stmt.excluded.open, "high": stmt.excluded.high, "low": stmt.excluded.low,
              "close": stmt.excluded.close, "volume": stmt.excluded.volume},
    )
    await session.execute(stmt)
    await session.commit()
    logger.info("backfill.intraday.done", symbol=spec.symbol, rows=len(rows))
    return len(rows)


async def run_full_backfill(session: AsyncSession, days: int = 365) -> None:
    await ensure_instruments_seeded(session)
    for spec in DEFAULT_INSTRUMENTS:
        await backfill_daily(session, spec, days)
        await backfill_recent_intraday(session, spec)
