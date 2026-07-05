"""SQLAlchemy ORM models for Terra Trade.

Time-series tables (bars_1m, regime_history, scores, equity_curve) are converted to
TimescaleDB hypertables in the Alembic migration, not here -- the ORM model just
defines the plain table shape (with the timestamp column included in the primary
key, which TimescaleDB requires for hypertable partitioning).
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy import Date as sa_Date
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Instrument(Base):
    __tablename__ = "instruments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    data_symbol: Mapped[str] = mapped_column(String(32), comment="Symbol used by the historical data vendor, e.g. ES=F")
    exchange: Mapped[str] = mapped_column(String(32), default="CME")
    contract_id: Mapped[str | None] = mapped_column(String(64), nullable=True, comment="ProjectX Gateway contractId")
    tick_size: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=Decimal("0.25"))
    point_value: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=Decimal("50"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Bar(Base):
    """1-minute OHLCV bar. 5m/15m/1h/1d are TimescaleDB continuous aggregates over this table."""

    __tablename__ = "bars_1m"

    time: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    open: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    high: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    low: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    close: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    volume: Mapped[Decimal] = mapped_column(Numeric(20, 4), default=Decimal("0"))

    __table_args__ = (Index("ix_bars_1m_symbol_time", "symbol", "time"),)


class DailyBar(Base):
    """Long-horizon daily OHLCV, backfilled 1+ year back via the free data vendor.

    Free intraday history (yfinance 1-minute bars) is only available for the
    trailing ~7 days -- true multi-year backfill is only realistic at daily
    granularity without a paid vendor. This table feeds analytics/regime
    training that needs a long lookback (ATR percentile, vol regime, EV over
    a full year); `bars_1m` remains the live intraday execution resolution.
    """

    __tablename__ = "bars_daily"

    date: Mapped[dt.date] = mapped_column(sa_Date, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    open: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    high: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    low: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    close: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    volume: Mapped[Decimal] = mapped_column(Numeric(20, 4), default=Decimal("0"))

    __table_args__ = (Index("ix_bars_daily_symbol_date", "symbol", "date"),)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    broker_account_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str] = mapped_column(String(128), default="default")
    starting_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("50000"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RiskLimit(Base):
    __tablename__ = "risk_limits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), unique=True)
    per_trade_risk_pct: Mapped[Decimal] = mapped_column(Numeric(6, 3), default=Decimal("0.5"))
    max_daily_loss_pct: Mapped[Decimal] = mapped_column(Numeric(6, 3), default=Decimal("3.0"))
    max_trailing_drawdown_pct: Mapped[Decimal] = mapped_column(Numeric(6, 3), default=Decimal("6.0"))
    max_position_size: Mapped[int] = mapped_column(Integer, default=3)
    max_consecutive_losses: Mapped[int] = mapped_column(Integer, default=3)
    max_daily_trades: Mapped[int] = mapped_column(Integer, default=8)

    account: Mapped[Account] = relationship()


class SystemState(Base):
    """Singleton row (id=1) holding the current trading mode and kill-switch flag."""

    __tablename__ = "system_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    mode: Mapped[str] = mapped_column(String(16), default="analysis_only")
    kill_switch: Mapped[bool] = mapped_column(Boolean, default=False)
    kill_switch_reason: Mapped[str | None] = mapped_column(String(512), nullable=True)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class RegimeSnapshot(Base):
    __tablename__ = "regime_history"

    time: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    trend_label: Mapped[str] = mapped_column(String(16))
    vol_label: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float] = mapped_column(Numeric(5, 4))
    features: Mapped[dict] = mapped_column(JSONB, default=dict)

    __table_args__ = (Index("ix_regime_history_symbol_time", "symbol", "time"),)


class NewsEvent(Base):
    __tablename__ = "news_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_time: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), index=True)
    country: Mapped[str] = mapped_column(String(8))
    name: Mapped[str] = mapped_column(String(256))
    impact: Mapped[str] = mapped_column(String(16), comment="low|medium|high")
    actual: Mapped[str | None] = mapped_column(String(64), nullable=True)
    forecast: Mapped[str | None] = mapped_column(String(64), nullable=True)
    previous: Mapped[str | None] = mapped_column(String(64), nullable=True)
    fetched_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (UniqueConstraint("event_time", "country", "name", name="uq_news_event"),)


class Score(Base):
    __tablename__ = "scores"

    time: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    side: Mapped[str] = mapped_column(String(8), comment="long|short")
    probability: Mapped[float] = mapped_column(Numeric(6, 5))
    decision: Mapped[str] = mapped_column(String(16), comment="taken|skipped_score|skipped_risk|skipped_news")
    features: Mapped[dict] = mapped_column(JSONB, default=dict)
    explanation: Mapped[str] = mapped_column(String(2048))
    trade_id: Mapped[int | None] = mapped_column(ForeignKey("trades.id"), nullable=True)

    __table_args__ = (Index("ix_scores_symbol_time", "symbol", "time"),)


class Trade(Base):
    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    strategy_id: Mapped[str] = mapped_column(String(64))
    side: Mapped[str] = mapped_column(String(8))
    quantity: Mapped[int] = mapped_column(Integer)
    entry_time: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    entry_price: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    stop_price: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    take_profit_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)
    exit_time: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)
    exit_reason: Mapped[str | None] = mapped_column(String(32), nullable=True, comment="stop|target|trailing_stop|manual|kill_switch")
    pnl: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    fees: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    mae: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True, comment="Max adverse excursion (points)")
    mfe: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True, comment="Max favorable excursion (points)")
    score: Mapped[float | None] = mapped_column(Numeric(6, 5), nullable=True)
    regime_trend_at_entry: Mapped[str | None] = mapped_column(String(16), nullable=True)
    regime_vol_at_entry: Mapped[str | None] = mapped_column(String(16), nullable=True)
    explanation: Mapped[str] = mapped_column(String(2048), default="")
    status: Mapped[str] = mapped_column(String(16), default="open", comment="open|closed")
    broker_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    account: Mapped[Account] = relationship()


class OrderRecord(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trade_id: Mapped[int | None] = mapped_column(ForeignKey("trades.id"), nullable=True)
    broker_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
    symbol: Mapped[str] = mapped_column(String(32))
    order_type: Mapped[str] = mapped_column(String(16), comment="market|limit|stop|trailing_stop")
    side: Mapped[str] = mapped_column(String(8))
    quantity: Mapped[int] = mapped_column(Integer)
    price: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", comment="pending|filled|cancelled|rejected")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    filled_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    filled_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)


class PositionRecord(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
    symbol: Mapped[str] = mapped_column(String(32))
    side: Mapped[str] = mapped_column(String(8))
    quantity: Mapped[int] = mapped_column(Integer)
    avg_price: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    unrealized_pnl: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (UniqueConstraint("account_id", "symbol", name="uq_position_account_symbol"),)


class EquityCurvePoint(Base):
    __tablename__ = "equity_curve"

    time: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    equity: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    balance: Mapped[Decimal] = mapped_column(Numeric(18, 2))

    __table_args__ = (Index("ix_equity_curve_account_time", "account_id", "time"),)
