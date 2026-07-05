"""Trading-mode gate.

`system_state` is a singleton row (id=1). The engine boots in ANALYSIS_ONLY
and stays there until an operator explicitly changes it. Reaching LIVE
additionally requires `settings.live_trading_confirmed=True` -- a second,
separate flag from `trading_mode` -- so nothing can auto-escalate from paper
to live by itself.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import BrokerKind, TradingMode, get_settings
from app.db.models import SystemState


class ModeChangeError(RuntimeError):
    pass


async def get_system_state(session: AsyncSession) -> SystemState:
    state = (await session.execute(select(SystemState).where(SystemState.id == 1))).scalar_one_or_none()
    if state is None:
        settings = get_settings()
        state = SystemState(id=1, mode=settings.trading_mode.value, kill_switch=False)
        session.add(state)
        await session.commit()
        await session.refresh(state)
    return state


async def set_mode(session: AsyncSession, mode: TradingMode) -> SystemState:
    settings = get_settings()
    if mode == TradingMode.LIVE:
        if settings.broker_kind != BrokerKind.PROJECTX:
            raise ModeChangeError("Cannot switch to LIVE mode: BROKER_KIND is not set to 'projectx'")
        if not settings.live_trading_confirmed:
            raise ModeChangeError(
                "Cannot switch to LIVE mode: LIVE_TRADING_CONFIRMED must be explicitly set to true, separately from TRADING_MODE"
            )

    state = await get_system_state(session)
    state.mode = mode.value
    await session.commit()
    await session.refresh(state)
    return state


async def clear_kill_switch(session: AsyncSession) -> SystemState:
    state = await get_system_state(session)
    state.kill_switch = False
    state.kill_switch_reason = None
    await session.commit()
    await session.refresh(state)
    return state


async def trip_kill_switch(session: AsyncSession, reason: str) -> SystemState:
    state = await get_system_state(session)
    state.kill_switch = True
    state.kill_switch_reason = reason
    await session.commit()
    await session.refresh(state)
    return state
