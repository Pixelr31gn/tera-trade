from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import TradingMode, get_settings
from app.core.security import require_api_key
from app.db.base import get_db
from app.execution.mode import ModeChangeError, clear_kill_switch, get_system_state, set_mode

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_api_key)])


class ModeChangeRequest(BaseModel):
    mode: TradingMode


@router.get("/state")
async def read_state(session: AsyncSession = Depends(get_db)):
    state = await get_system_state(session)
    settings = get_settings()
    return {
        "mode": state.mode,
        "kill_switch": state.kill_switch,
        "kill_switch_reason": state.kill_switch_reason,
        "broker_kind": settings.broker_kind.value,
        "min_score_threshold": settings.min_score_threshold,
        "updated_at": state.updated_at,
    }


@router.post("/mode")
async def change_mode(payload: ModeChangeRequest, session: AsyncSession = Depends(get_db)):
    try:
        state = await set_mode(session, payload.mode)
    except ModeChangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"mode": state.mode}


@router.post("/kill-switch/clear")
async def clear_kill_switch_endpoint(session: AsyncSession = Depends(get_db)):
    state = await clear_kill_switch(session)
    return {"kill_switch": state.kill_switch}
