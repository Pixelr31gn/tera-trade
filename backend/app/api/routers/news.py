from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_api_key
from app.db.base import get_db
from app.db.models import NewsEvent
from app.news.risk import get_news_risk_status

router = APIRouter(prefix="/api/news", tags=["news"], dependencies=[Depends(require_api_key)])


@router.get("/upcoming")
async def upcoming_events(session: AsyncSession = Depends(get_db)):
    now = dt.datetime.now(dt.timezone.utc)
    rows = (
        await session.execute(
            select(NewsEvent)
            .where(NewsEvent.event_time >= now - dt.timedelta(hours=6), NewsEvent.event_time <= now + dt.timedelta(days=7))
            .order_by(NewsEvent.event_time.asc())
        )
    ).scalars().all()
    return [
        {"time": r.event_time, "country": r.country, "name": r.name, "impact": r.impact, "forecast": r.forecast, "previous": r.previous}
        for r in rows
    ]


@router.get("/risk-status")
async def risk_status(session: AsyncSession = Depends(get_db)):
    status = await get_news_risk_status(session)
    return status.__dict__
