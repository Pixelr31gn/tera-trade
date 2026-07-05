"""One-time setup helpers: default account/risk-limits row, bar history loading."""
from __future__ import annotations

import datetime as dt

import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import Account, Bar, RiskLimit


async def ensure_default_account(session: AsyncSession) -> Account:
    account = (await session.execute(select(Account).where(Account.name == "default"))).scalar_one_or_none()
    if account is not None:
        return account

    settings = get_settings()
    account = Account(name="default", starting_balance=50000, is_active=True)
    session.add(account)
    await session.flush()

    session.add(
        RiskLimit(
            account_id=account.id,
            per_trade_risk_pct=settings.default_per_trade_risk_pct,
            max_daily_loss_pct=settings.default_max_daily_loss_pct,
            max_trailing_drawdown_pct=settings.default_max_trailing_drawdown_pct,
            max_position_size=settings.default_max_position_size,
            max_consecutive_losses=settings.max_consecutive_losses,
            max_daily_trades=settings.max_daily_trades,
        )
    )
    await session.commit()
    await session.refresh(account)
    return account


async def load_recent_bars(session: AsyncSession, symbol: str, limit: int = 300) -> pd.DataFrame:
    rows = (
        await session.execute(
            select(Bar.time, Bar.open, Bar.high, Bar.low, Bar.close, Bar.volume)
            .where(Bar.symbol == symbol)
            .order_by(Bar.time.desc())
            .limit(limit)
        )
    ).all()
    if not rows:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    rows = list(reversed(rows))
    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
    df = df.set_index("time")
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = df[col].astype(float)
    return df
