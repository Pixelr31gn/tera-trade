from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_api_key
from app.db.base import get_db
from app.db.models import Account, EquityCurvePoint, RiskLimit
from app.engine.bootstrap import ensure_default_account


class RiskLimitsUpdate(BaseModel):
    per_trade_risk_pct: float = Field(gt=0, le=10)
    max_daily_loss_pct: float = Field(gt=0, le=50)
    max_trailing_drawdown_pct: float = Field(gt=0, le=50)
    max_position_size: int = Field(gt=0, le=100)
    max_consecutive_losses: int = Field(gt=0, le=20)
    max_daily_trades: int = Field(gt=0, le=100)

router = APIRouter(prefix="/api/accounts", tags=["accounts"], dependencies=[Depends(require_api_key)])


@router.get("")
async def list_accounts(session: AsyncSession = Depends(get_db)):
    account = await ensure_default_account(session)
    limits = (await session.execute(select(RiskLimit).where(RiskLimit.account_id == account.id))).scalar_one()
    return [
        {
            "id": account.id,
            "name": account.name,
            "starting_balance": account.starting_balance,
            "risk_limits": {
                "per_trade_risk_pct": limits.per_trade_risk_pct,
                "max_daily_loss_pct": limits.max_daily_loss_pct,
                "max_trailing_drawdown_pct": limits.max_trailing_drawdown_pct,
                "max_position_size": limits.max_position_size,
                "max_consecutive_losses": limits.max_consecutive_losses,
                "max_daily_trades": limits.max_daily_trades,
            },
        }
    ]


@router.patch("/{account_id}/risk-limits")
async def update_risk_limits(account_id: int, payload: RiskLimitsUpdate, session: AsyncSession = Depends(get_db)):
    limits = (await session.execute(select(RiskLimit).where(RiskLimit.account_id == account_id))).scalar_one_or_none()
    if limits is None:
        raise HTTPException(status_code=404, detail="No risk limits configured for this account")
    for field, value in payload.model_dump().items():
        setattr(limits, field, value)
    await session.commit()
    return {"status": "updated"}


@router.get("/{account_id}/equity-curve")
async def equity_curve(account_id: int, days: int = Query(default=30, ge=1, le=730), session: AsyncSession = Depends(get_db)):
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    rows = (
        await session.execute(
            select(EquityCurvePoint)
            .where(EquityCurvePoint.account_id == account_id, EquityCurvePoint.time >= since)
            .order_by(EquityCurvePoint.time.asc())
        )
    ).scalars().all()
    return [{"time": r.time, "equity": r.equity, "balance": r.balance} for r in rows]
