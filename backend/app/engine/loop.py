"""The orchestration loop: new bar -> manage open trades -> evaluate new signals.

This is the one place that wires market_data -> regime -> news -> strategy ->
scoring -> risk -> execution -> explanation together. Everything above it is a
pure, independently-testable module; this is the glue.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.brokers.base import BrokerClient, ClosedSimTrade
from app.brokers.simulated import SimulatedBroker
from app.core.config import TradingMode, get_settings
from app.core.logging import get_logger
from app.db.base import session_scope
from app.db.models import Account, RegimeSnapshot, RiskLimit, Score, Trade
from app.engine.accounting import compute_account_equity, compute_account_risk_state, record_equity_point
from app.engine.bootstrap import ensure_default_account, load_recent_bars
from app.explain.engine import explain_kill_switch, explain_risk_rejection, explain_score, explain_trade_exit
from app.execution.engine import execute_if_approved
from app.execution.mode import get_system_state, trip_kill_switch
from app.market_data.instruments import get_instrument
from app.news.risk import get_news_risk_status
from app.regime.classifier import classify_regime
from app.regime.indicators import atr as compute_atr
from app.risk.circuit_breakers import RiskLimitsConfig
from app.risk.engine import RiskEngine
from app.scoring.features import build_setup_features
from app.scoring.gate import evaluate_setup
from app.strategy import ALL_STRATEGIES

logger = get_logger(__name__)

MIN_BARS_FOR_REGIME = 120

# In-memory MAE/MFE tracking, keyed by trade id. Reset on process restart --
# acceptable for Phase 0 (single-process engine); a durable version would
# persist a running high/low alongside the trade row on every bar.
_trade_excursion: dict[int, tuple[Decimal, Decimal]] = {}  # trade_id -> (max_favorable, max_adverse), both >= 0 points


class TradingEngine:
    def __init__(self, broker: BrokerClient | None = None, event_sink=None) -> None:
        self.broker = broker or SimulatedBroker()
        self.risk_engine = RiskEngine()
        self._event_sink = event_sink  # optional async callable(dict) -> None, e.g. websocket broadcaster
        self._account: Account | None = None

    async def _emit(self, event: dict) -> None:
        if self._event_sink is not None:
            await self._event_sink(event)

    async def on_new_bar(self, symbol: str, bar_time: dt.datetime, o: Decimal, h: Decimal, l: Decimal, c: Decimal, v: Decimal) -> None:
        async with session_scope() as session:
            account = await ensure_default_account(session)
            self._account = account
            system_state = await get_system_state(session)
            mode = TradingMode(system_state.mode)

            await self._manage_open_trades(session, account, symbol, bar_time, h, l, c)

            if system_state.kill_switch:
                await self._emit({"type": "kill_switch_active", "reason": system_state.kill_switch_reason})
            else:
                await self._evaluate_new_signals(session, account, mode, symbol, bar_time, c)

            equity = await compute_account_equity(session, account, {symbol: c})
            await record_equity_point(session, account.id, equity, Decimal(account.starting_balance), bar_time)
            await self._emit({"type": "equity_update", "account_id": account.id, "equity": str(equity), "time": bar_time.isoformat()})

    async def _manage_open_trades(self, session: AsyncSession, account: Account, symbol: str, bar_time: dt.datetime, h: Decimal, l: Decimal, c: Decimal) -> None:
        from sqlalchemy import select

        open_trade = (
            await session.execute(
                select(Trade).where(Trade.account_id == account.id, Trade.symbol == symbol, Trade.status == "open")
            )
        ).scalar_one_or_none()
        if open_trade is not None:
            self._track_excursion(open_trade, h, l)

        if not isinstance(self.broker, SimulatedBroker):
            return  # live broker manages its own brackets server-side

        broker_account_id = (await self.broker.get_accounts())[0].account_id
        self.broker.update_trailing_stop(broker_account_id, symbol, c)
        closed = self.broker.evaluate_bar(broker_account_id, symbol, h, l, bar_time)
        if closed is None:
            return
        await self._close_trade(session, account, closed)

    @staticmethod
    def _track_excursion(trade: Trade, h: Decimal, l: Decimal) -> None:
        """Update running max-favorable/max-adverse excursion (in points) for an open trade."""
        direction = 1 if trade.side == "long" else -1
        favorable_extreme = h if direction == 1 else l
        adverse_extreme = l if direction == 1 else h
        favorable_move = max(Decimal("0"), (favorable_extreme - trade.entry_price) * direction)
        adverse_move = max(Decimal("0"), (trade.entry_price - adverse_extreme) * direction)

        mfe, mae = _trade_excursion.get(trade.id, (Decimal("0"), Decimal("0")))
        _trade_excursion[trade.id] = (max(mfe, favorable_move), max(mae, adverse_move))

    async def _close_trade(self, session: AsyncSession, account: Account, closed: ClosedSimTrade) -> None:
        from sqlalchemy import select

        trade = (
            await session.execute(
                select(Trade)
                .where(Trade.account_id == account.id, Trade.symbol == closed.symbol, Trade.status == "open")
                .order_by(Trade.entry_time.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if trade is None:
            return

        instrument = get_instrument(trade.symbol)
        direction = 1 if trade.side == "long" else -1
        pnl = (closed.exit_price - trade.entry_price) * direction * instrument.point_value * trade.quantity

        mfe, mae = _trade_excursion.pop(trade.id, (Decimal("0"), Decimal("0")))

        trade.exit_time = closed.exit_time
        trade.exit_price = closed.exit_price
        trade.exit_reason = closed.exit_reason
        trade.pnl = pnl
        trade.mae = mae
        trade.mfe = mfe
        trade.status = "closed"
        explanation = explain_trade_exit(trade.symbol, trade.side, closed.exit_reason, closed.exit_price, pnl)
        trade.explanation = f"{trade.explanation} {explanation}"
        await session.commit()
        await self._emit({"type": "trade_closed", "trade_id": trade.id, "symbol": trade.symbol, "pnl": str(pnl), "explanation": explanation})

    async def _evaluate_new_signals(self, session: AsyncSession, account: Account, mode: TradingMode, symbol: str, bar_time: dt.datetime, close_price: Decimal) -> None:
        df = await load_recent_bars(session, symbol, limit=300)
        if len(df) < MIN_BARS_FOR_REGIME:
            return

        regime = classify_regime(df)
        session.add(
            RegimeSnapshot(
                time=bar_time, symbol=symbol, trend_label=regime.trend_label, vol_label=regime.vol_label,
                confidence=regime.confidence, features=regime.features,
            )
        )
        await session.commit()
        await self._emit({"type": "regime", "symbol": symbol, "trend_label": regime.trend_label, "vol_label": regime.vol_label, "confidence": regime.confidence})

        # Skip generating new entries into a symbol that already has an open position.
        from sqlalchemy import select

        has_open = (
            await session.execute(select(Trade.id).where(Trade.account_id == account.id, Trade.symbol == symbol, Trade.status == "open"))
        ).first()
        if has_open:
            return  # excursion tracking for this open position already happened in _manage_open_trades

        news_status = await get_news_risk_status(session, bar_time)
        settings = get_settings()

        for strategy in ALL_STRATEGIES:
            signal = strategy.generate_signal(symbol, df)
            if signal is None:
                continue

            features = build_setup_features(
                df, symbol, signal.side, regime, bar_time,
                news_risk_flag=news_status.in_risk_window,
                news_minutes_to_event=news_status.minutes_to_event,
            )
            gated = evaluate_setup(features)
            explanation = explain_score(symbol, signal.side, gated, settings.min_score_threshold)

            session.add(
                Score(
                    time=bar_time, symbol=symbol, strategy_id=signal.strategy_id, side=signal.side,
                    probability=gated.probability, decision=gated.decision, features=features.as_dict(),
                    explanation=explanation,
                )
            )
            await session.commit()
            await self._emit({"type": "score", "symbol": symbol, "side": signal.side, "probability": gated.probability, "decision": gated.decision, "explanation": explanation})

            if gated.decision != "taken":
                continue

            risk_limits_row = (
                await session.execute(select(RiskLimit).where(RiskLimit.account_id == account.id))
            ).scalar_one()
            limits = RiskLimitsConfig(
                per_trade_risk_pct=Decimal(risk_limits_row.per_trade_risk_pct),
                max_daily_loss_pct=Decimal(risk_limits_row.max_daily_loss_pct),
                max_trailing_drawdown_pct=Decimal(risk_limits_row.max_trailing_drawdown_pct),
                max_consecutive_losses=risk_limits_row.max_consecutive_losses,
                max_daily_trades=risk_limits_row.max_daily_trades,
                max_position_size=risk_limits_row.max_position_size,
            )
            equity = await compute_account_equity(session, account, {symbol: close_price})
            account_state = await compute_account_risk_state(session, account, equity)
            instrument = get_instrument(symbol)
            atr_series = compute_atr(df).dropna()
            if atr_series.empty:
                continue
            atr_value = Decimal(str(atr_series.iloc[-1]))

            assessment = self.risk_engine.assess_new_trade(
                side=signal.side, entry_price=close_price, atr_value=atr_value,
                structure_swing_price=signal.structure_swing_price, account_state=account_state,
                limits=limits, point_value=instrument.point_value, tick_size=instrument.tick_size,
                news_status=news_status,
            )

            if assessment.trip_kill_switch:
                await trip_kill_switch(session, assessment.reason)
                await self._emit({"type": "kill_switch_tripped", "reason": explain_kill_switch(assessment.reason)})
                return

            if not assessment.approved:
                rejection = explain_risk_rejection(symbol, signal.side, assessment)
                await self._emit({"type": "risk_rejected", "symbol": symbol, "reason": rejection})
                continue

            broker_account_id = (await self.broker.get_accounts())[0].account_id
            result = await execute_if_approved(
                session, self.broker, mode, account.id, broker_account_id, signal, gated, assessment,
                close_price, regime.trend_label, regime.vol_label, explanation, bar_time,
            )
            await self._emit({"type": "execution", "symbol": symbol, "executed": result.executed, "reason": result.reason, "trade_id": result.trade_id})
            return  # one new position per symbol per bar
