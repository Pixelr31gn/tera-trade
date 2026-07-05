"""Free economic-calendar ingestion.

Primary source: Forex Factory's public weekly JSON feed. It's an unofficial,
undocumented endpoint (no official ForexFactory API exists) -- fragile by
nature, so this module fails soft: on any fetch/parse error it logs and
leaves the existing `news_events` rows untouched rather than raising, and a
manually-maintained fallback file can be dropped at
`app/news/manual_calendar.json` in the same shape for outage coverage.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import NewsEvent

logger = get_logger(__name__)

_IMPACT_MAP = {
    "high": "high",
    "red": "high",
    "3": "high",
    "medium": "medium",
    "orange": "medium",
    "yellow": "medium",
    "2": "medium",
    "low": "low",
    "1": "low",
    "0": "low",
}

_MANUAL_FALLBACK_PATH = Path(__file__).parent / "manual_calendar.json"


def _normalize_impact(raw: Any) -> str:
    key = str(raw).strip().lower()
    return _IMPACT_MAP.get(key, "low")


def _parse_events(raw_items: list[dict]) -> list[dict]:
    events = []
    for item in raw_items:
        try:
            date_str = item.get("date") or item.get("dateline")
            if isinstance(date_str, (int, float)):
                event_time = dt.datetime.fromtimestamp(float(date_str), tz=dt.timezone.utc)
            else:
                event_time = dt.datetime.fromisoformat(str(date_str).replace("Z", "+00:00"))
                if event_time.tzinfo is None:
                    event_time = event_time.replace(tzinfo=dt.timezone.utc)
            events.append(
                {
                    "event_time": event_time,
                    "country": str(item.get("country", "")).upper()[:8],
                    "name": str(item.get("title") or item.get("event") or "Unknown event")[:256],
                    "impact": _normalize_impact(item.get("impact", "low")),
                    "actual": str(item["actual"])[:64] if item.get("actual") not in (None, "") else None,
                    "forecast": str(item["forecast"])[:64] if item.get("forecast") not in (None, "") else None,
                    "previous": str(item["previous"])[:64] if item.get("previous") not in (None, "") else None,
                }
            )
        except (ValueError, TypeError, KeyError):
            logger.warning("news_calendar.skip_unparseable_event", item=item)
            continue
    return events


async def fetch_calendar_json() -> list[dict]:
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(settings.news_calendar_url, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        logger.warning("news_calendar.fetch_failed", error=str(exc))
        if _MANUAL_FALLBACK_PATH.exists():
            logger.info("news_calendar.using_manual_fallback")
            return json.loads(_MANUAL_FALLBACK_PATH.read_text())
        return []


async def refresh_calendar(session: AsyncSession) -> int:
    raw_items = await fetch_calendar_json()
    events = _parse_events(raw_items)
    if not events:
        return 0

    stmt = pg_insert(NewsEvent).values(events)
    stmt = stmt.on_conflict_do_update(
        index_elements=["event_time", "country", "name"],
        set_={"actual": stmt.excluded.actual, "forecast": stmt.excluded.forecast, "previous": stmt.excluded.previous},
    )
    await session.execute(stmt)
    await session.commit()
    logger.info("news_calendar.refreshed", count=len(events))
    return len(events)
