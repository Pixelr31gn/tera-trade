"""News-driven risk windows: is `now` close enough to a high-impact release
that the risk engine should block new entries or shrink size?
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import NewsEvent


@dataclass(frozen=True)
class NewsRiskStatus:
    in_risk_window: bool
    nearest_event_name: str | None
    nearest_event_time: dt.datetime | None
    minutes_to_event: float | None
    impact: str | None


async def get_news_risk_status(session: AsyncSession, now: dt.datetime | None = None) -> NewsRiskStatus:
    settings = get_settings()
    now = now or dt.datetime.now(dt.timezone.utc)
    window = dt.timedelta(minutes=settings.news_risk_window_minutes)

    query = select(NewsEvent).where(
        NewsEvent.event_time >= now - window,
        NewsEvent.event_time <= now + window,
    )
    if settings.news_high_impact_only:
        query = query.where(NewsEvent.impact == "high")

    events = (await session.execute(query.order_by(NewsEvent.event_time))).scalars().all()
    if not events:
        return NewsRiskStatus(False, None, None, None, None)

    nearest = min(events, key=lambda e: abs((e.event_time - now).total_seconds()))
    minutes_to = (nearest.event_time - now).total_seconds() / 60
    return NewsRiskStatus(
        in_risk_window=True,
        nearest_event_name=nearest.name,
        nearest_event_time=nearest.event_time,
        minutes_to_event=minutes_to,
        impact=nearest.impact,
    )
