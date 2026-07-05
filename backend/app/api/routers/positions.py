from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_api_key
from app.db.base import get_db
from app.db.models import OrderRecord, Trade

router = APIRouter(prefix="/api", tags=["positions"], dependencies=[Depends(require_api_key)])


@router.get("/positions")
async def list_open_positions(session: AsyncSession = Depends(get_db)):
    rows = (await session.execute(select(Trade).where(Trade.status == "open").order_by(Trade.entry_time.desc()))).scalars().all()
    return [
        {
            "trade_id": t.id,
            "symbol": t.symbol,
            "side": t.side,
            "quantity": t.quantity,
            "entry_price": t.entry_price,
            "stop_price": t.stop_price,
            "take_profit_price": t.take_profit_price,
            "entry_time": t.entry_time,
            "strategy_id": t.strategy_id,
            "score": t.score,
            "explanation": t.explanation,
        }
        for t in rows
    ]


@router.get("/orders")
async def list_orders(session: AsyncSession = Depends(get_db)):
    rows = (await session.execute(select(OrderRecord).order_by(OrderRecord.created_at.desc()).limit(100))).scalars().all()
    return [
        {
            "id": o.id,
            "symbol": o.symbol,
            "side": o.side,
            "order_type": o.order_type,
            "quantity": o.quantity,
            "status": o.status,
            "price": o.price,
            "filled_price": o.filled_price,
            "created_at": o.created_at,
        }
        for o in rows
    ]
