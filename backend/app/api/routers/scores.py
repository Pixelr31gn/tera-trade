from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_api_key
from app.db.base import get_db
from app.db.models import Score

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"], dependencies=[Depends(require_api_key)])


@router.get("")
async def list_recent_scores(limit: int = Query(default=100, ge=1, le=500), session: AsyncSession = Depends(get_db)):
    rows = (await session.execute(select(Score).order_by(Score.time.desc()).limit(limit))).scalars().all()
    return [
        {
            "time": s.time,
            "symbol": s.symbol,
            "strategy_id": s.strategy_id,
            "side": s.side,
            "probability": s.probability,
            "decision": s.decision,
            "explanation": s.explanation,
            "trade_id": s.trade_id,
        }
        for s in rows
    ]
