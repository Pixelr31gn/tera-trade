from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics.stats import compute_portfolio_stats, compute_trade_stats
from app.core.security import require_api_key
from app.db.base import get_db
from app.db.models import EquityCurvePoint, Trade
from app.engine.bootstrap import ensure_default_account

router = APIRouter(prefix="/api/performance", tags=["performance"], dependencies=[Depends(require_api_key)])


@router.get("/summary")
async def performance_summary(session: AsyncSession = Depends(get_db)):
    account = await ensure_default_account(session)

    closed = (
        await session.execute(select(Trade).where(Trade.account_id == account.id, Trade.status == "closed"))
    ).scalars().all()
    trades_df = pd.DataFrame(
        [{"pnl": float(t.pnl or 0), "mae": float(t.mae) if t.mae is not None else None, "mfe": float(t.mfe) if t.mfe is not None else None} for t in closed]
    )
    trade_stats = compute_trade_stats(trades_df)

    equity_rows = (
        await session.execute(
            select(EquityCurvePoint).where(EquityCurvePoint.account_id == account.id).order_by(EquityCurvePoint.time.asc())
        )
    ).scalars().all()
    equity_series = pd.Series([float(r.equity) for r in equity_rows], index=[r.time for r in equity_rows])
    portfolio_stats = compute_portfolio_stats(equity_series)

    by_strategy = {}
    by_regime = {}
    for t in closed:
        by_strategy.setdefault(t.strategy_id, []).append(float(t.pnl or 0))
        key = f"{t.regime_trend_at_entry}/{t.regime_vol_at_entry}"
        by_regime.setdefault(key, []).append(float(t.pnl or 0))

    def _bucket_summary(buckets: dict[str, list[float]]) -> dict:
        return {
            k: {"trade_count": len(v), "total_pnl": sum(v), "win_rate": sum(1 for x in v if x > 0) / len(v) if v else 0}
            for k, v in buckets.items()
        }

    return {
        "trade_stats": trade_stats.__dict__,
        "portfolio_stats": portfolio_stats.__dict__,
        "by_strategy": _bucket_summary(by_strategy),
        "by_regime": _bucket_summary(by_regime),
    }
