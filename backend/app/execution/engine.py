"""Execution engine: routes an approved, scored setup to an actual order --
or, in ANALYSIS_ONLY mode, to nowhere at all.

This is the only module allowed to call `BrokerClient.place_order`. Every
other module works with Signal/GatedScore/RiskAssessment objects and never
touches the broker directly, so the mode gate here is the single choke point
that guarantees ANALYSIS_ONLY never places an order, real or simulated.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.brokers.base import BrokerClient, OrderRequest, OrderSide, OrderType
from app.core.config import TradingMode
from app.core.logging import get_logger
from app.db.models import OrderRecord, Trade
from app.risk.engine import RiskAssessment
from app.scoring.gate import GatedScore
from app.strategy.base import Signal

logger = get_logger(__name__)


@dataclass(frozen=True)
class ExecutionResult:
    executed: bool
    trade_id: int | None
    reason: str


async def execute_if_approved(
    session: AsyncSession,
    broker: BrokerClient,
    mode: TradingMode,
    account_id: int,
    broker_account_id: str,
    signal: Signal,
    gated: GatedScore,
    assessment: RiskAssessment,
    entry_price: Decimal,
    regime_trend: str,
    regime_vol: str,
    explanation: str,
    entry_time: dt.datetime | None = None,
) -> ExecutionResult:
    if gated.decision != "taken":
        return ExecutionResult(False, None, "setup did not clear the scoring threshold")
    if not assessment.approved:
        return ExecutionResult(False, None, "risk engine did not approve this trade")

    if mode == TradingMode.ANALYSIS_ONLY:
        logger.info("execution.analysis_only_skip", symbol=signal.symbol, side=signal.side)
        return ExecutionResult(False, None, "analysis-only mode: setup qualified but no order was placed")

    entry_time = entry_time or dt.datetime.now(dt.timezone.utc)
    side = OrderSide.BUY if signal.side == "long" else OrderSide.SELL

    order_request = OrderRequest(
        account_id=broker_account_id,
        symbol=signal.symbol,
        side=side,
        order_type=OrderType.MARKET,
        quantity=assessment.quantity,
        stop_loss_price=assessment.stop_price,
        take_profit_price=assessment.take_profit_price,
        trail_ticks=assessment.trail_ticks,
        custom_tag=f"{signal.strategy_id}:{entry_time.isoformat()}",
        reference_price=entry_price,
    )
    result = await broker.place_order(order_request)
    if result.status == "rejected":
        logger.warning("execution.order_rejected", symbol=signal.symbol, error=result.error)
        return ExecutionResult(False, None, f"broker rejected the order: {result.error}")

    fill_price = result.filled_price or entry_price
    trade = Trade(
        account_id=account_id,
        symbol=signal.symbol,
        strategy_id=signal.strategy_id,
        side=signal.side,
        quantity=assessment.quantity,
        entry_time=entry_time,
        entry_price=fill_price,
        stop_price=assessment.stop_price,
        take_profit_price=assessment.take_profit_price,
        score=gated.probability,
        regime_trend_at_entry=regime_trend,
        regime_vol_at_entry=regime_vol,
        explanation=explanation,
        status="open",
        broker_order_id=result.broker_order_id,
    )
    session.add(trade)
    await session.flush()

    session.add(
        OrderRecord(
            trade_id=trade.id,
            broker_order_id=result.broker_order_id,
            account_id=account_id,
            symbol=signal.symbol,
            order_type="market",
            side=signal.side,
            quantity=assessment.quantity,
            price=fill_price,
            status="filled" if result.status == "filled" else "pending",
            filled_at=result.filled_at,
            filled_price=fill_price,
        )
    )
    await session.commit()
    logger.info("execution.trade_opened", trade_id=trade.id, symbol=signal.symbol, side=signal.side, quantity=assessment.quantity)
    return ExecutionResult(True, trade.id, "order placed")
