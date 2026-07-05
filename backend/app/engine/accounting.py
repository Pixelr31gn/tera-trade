"""Account equity, drawdown, and streak bookkeeping used to feed the risk engine."""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Account, EquityCurvePoint, Instrument, Trade
from app.risk.circuit_breakers import AccountRiskState


async def compute_open_unrealized_pnl(session: AsyncSession, account_id: int, last_prices: dict[str, Decimal]) -> Decimal:
    open_trades = (
        await session.execute(select(Trade).where(Trade.account_id == account_id, Trade.status == "open"))
    ).scalars().all()
    if not open_trades:
        return Decimal("0")

    point_values = {
        row.symbol: row.point_value
        for row in (await session.execute(select(Instrument))).scalars().all()
    }

    total = Decimal("0")
    for trade in open_trades:
        last_price = last_prices.get(trade.symbol)
        if last_price is None:
            continue
        point_value = point_values.get(trade.symbol, Decimal("1"))
        direction = 1 if trade.side == "long" else -1
        total += (last_price - trade.entry_price) * direction * point_value * trade.quantity
    return total


async def compute_account_equity(session: AsyncSession, account: Account, last_prices: dict[str, Decimal]) -> Decimal:
    realized = (
        await session.execute(
            select(func.coalesce(func.sum(Trade.pnl), 0)).where(Trade.account_id == account.id, Trade.status == "closed")
        )
    ).scalar_one()
    unrealized = await compute_open_unrealized_pnl(session, account.id, last_prices)
    return Decimal(account.starting_balance) + Decimal(realized) + unrealized


async def record_equity_point(session: AsyncSession, account_id: int, equity: Decimal, balance: Decimal, at: dt.datetime) -> None:
    session.add(EquityCurvePoint(time=at, account_id=account_id, equity=equity, balance=balance))
    await session.commit()


async def compute_account_risk_state(session: AsyncSession, account: Account, current_equity: Decimal) -> AccountRiskState:
    now = dt.datetime.now(dt.timezone.utc)
    today_start = dt.datetime.combine(now.date(), dt.time.min, tzinfo=dt.timezone.utc)

    peak_equity = (
        await session.execute(select(func.max(EquityCurvePoint.equity)).where(EquityCurvePoint.account_id == account.id))
    ).scalar_one()
    peak_equity = Decimal(peak_equity) if peak_equity is not None else current_equity
    peak_equity = max(peak_equity, current_equity)

    first_today = (
        await session.execute(
            select(EquityCurvePoint.equity)
            .where(EquityCurvePoint.account_id == account.id, EquityCurvePoint.time >= today_start)
            .order_by(EquityCurvePoint.time.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    daily_starting_equity = Decimal(first_today) if first_today is not None else current_equity

    recent_closed = (
        await session.execute(
            select(Trade.pnl)
            .where(Trade.account_id == account.id, Trade.status == "closed")
            .order_by(Trade.exit_time.desc())
            .limit(50)
        )
    ).scalars().all()
    consecutive_losses = 0
    for pnl in recent_closed:
        if pnl is not None and pnl < 0:
            consecutive_losses += 1
        else:
            break

    trades_today = (
        await session.execute(
            select(func.count(Trade.id)).where(Trade.account_id == account.id, Trade.entry_time >= today_start)
        )
    ).scalar_one()

    return AccountRiskState(
        current_equity=current_equity,
        peak_equity=peak_equity,
        daily_starting_equity=daily_starting_equity,
        consecutive_losses=consecutive_losses,
        trades_today=trades_today,
    )
