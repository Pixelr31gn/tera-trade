from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_api_key
from app.db.base import get_db
from app.db.models import RegimeSnapshot
from app.market_data.instruments import DEFAULT_INSTRUMENTS

router = APIRouter(prefix="/api/regime", tags=["regime"], dependencies=[Depends(require_api_key)])


@router.get("/current")
async def current_regime(session: AsyncSession = Depends(get_db)):
    out = {}
    for spec in DEFAULT_INSTRUMENTS:
        row = (
            await session.execute(
                select(RegimeSnapshot).where(RegimeSnapshot.symbol == spec.symbol).order_by(RegimeSnapshot.time.desc()).limit(1)
            )
        ).scalar_one_or_none()
        if row is not None:
            out[spec.symbol] = {
                "time": row.time,
                "trend_label": row.trend_label,
                "vol_label": row.vol_label,
                "confidence": row.confidence,
                "features": row.features,
            }
    return out
