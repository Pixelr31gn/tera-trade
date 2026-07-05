from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.security import require_api_key
from app.db.base import get_db, session_scope
from app.market_data.backfill import run_full_backfill
from app.news.calendar import refresh_calendar

router = APIRouter(prefix="/api/backfill", tags=["backfill"], dependencies=[Depends(require_api_key)])
logger = get_logger(__name__)


async def _run_backfill_job() -> None:
    settings = get_settings()
    async with session_scope() as session:
        await run_full_backfill(session, days=settings.historical_backfill_days)
        await refresh_calendar(session)
    logger.info("backfill.job_complete")


@router.post("/run")
async def trigger_backfill(background_tasks: BackgroundTasks, session: AsyncSession = Depends(get_db)):
    background_tasks.add_task(_run_backfill_job)
    return {"status": "started"}
