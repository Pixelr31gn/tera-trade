from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_api_key
from app.db.base import get_db
from app.db.models import Trade

router = APIRouter(prefix="/api/trades", tags=["trades"], dependencies=[Depends(require_api_key)])


@router.get("")
async def list_trades(
    status: str | None = Query(default=None, description="open|closed"),
    symbol: str | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
    session: AsyncSession = Depends(get_db),
):
    query = select(Trade).order_by(Trade.entry_time.desc()).limit(limit)
    if status:
        query = query.where(Trade.status == status)
    if symbol:
        query = query.where(Trade.symbol == symbol)
    rows = (await session.execute(query)).scalars().all()
    return [
        {
            "id": t.id,
            "symbol": t.symbol,
            "strategy_id": t.strategy_id,
            "side": t.side,
            "quantity": t.quantity,
            "entry_time": t.entry_time,
            "entry_price": t.entry_price,
            "exit_time": t.exit_time,
            "exit_price": t.exit_price,
            "exit_reason": t.exit_reason,
            "pnl": t.pnl,
            "mae": t.mae,
            "mfe": t.mfe,
            "score": t.score,
            "regime_trend_at_entry": t.regime_trend_at_entry,
            "regime_vol_at_entry": t.regime_vol_at_entry,
            "status": t.status,
            "explanation": t.explanation,
        }
        for t in rows
    ]
