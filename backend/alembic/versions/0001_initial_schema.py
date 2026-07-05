"""initial schema + timescaledb hypertables + continuous aggregates

Revision ID: 0001_initial
Revises:
Create Date: 2026-07-04

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")

    op.create_table(
        "instruments",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("symbol", sa.String(32), unique=True, index=True, nullable=False),
        sa.Column("data_symbol", sa.String(32), nullable=False),
        sa.Column("exchange", sa.String(32), server_default="CME"),
        sa.Column("contract_id", sa.String(64), nullable=True),
        sa.Column("tick_size", sa.Numeric(18, 8), server_default="0.25"),
        sa.Column("point_value", sa.Numeric(18, 8), server_default="50"),
        sa.Column("active", sa.Boolean, server_default=sa.true()),
    )

    op.create_table(
        "bars_1m",
        sa.Column("time", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("symbol", sa.String(32), primary_key=True),
        sa.Column("open", sa.Numeric(18, 8), nullable=False),
        sa.Column("high", sa.Numeric(18, 8), nullable=False),
        sa.Column("low", sa.Numeric(18, 8), nullable=False),
        sa.Column("close", sa.Numeric(18, 8), nullable=False),
        sa.Column("volume", sa.Numeric(20, 4), server_default="0"),
    )
    op.create_index("ix_bars_1m_symbol_time", "bars_1m", ["symbol", "time"])
    op.execute("SELECT create_hypertable('bars_1m', 'time', if_not_exists => TRUE)")

    op.create_table(
        "bars_daily",
        sa.Column("date", sa.Date, primary_key=True),
        sa.Column("symbol", sa.String(32), primary_key=True),
        sa.Column("open", sa.Numeric(18, 8), nullable=False),
        sa.Column("high", sa.Numeric(18, 8), nullable=False),
        sa.Column("low", sa.Numeric(18, 8), nullable=False),
        sa.Column("close", sa.Numeric(18, 8), nullable=False),
        sa.Column("volume", sa.Numeric(20, 4), server_default="0"),
    )
    op.create_index("ix_bars_daily_symbol_date", "bars_daily", ["symbol", "date"])

    op.create_table(
        "accounts",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("broker_account_id", sa.String(64), nullable=True),
        sa.Column("name", sa.String(128), server_default="default"),
        sa.Column("starting_balance", sa.Numeric(18, 2), server_default="50000"),
        sa.Column("is_active", sa.Boolean, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "risk_limits",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.Integer, sa.ForeignKey("accounts.id"), unique=True, nullable=False),
        sa.Column("per_trade_risk_pct", sa.Numeric(6, 3), server_default="0.5"),
        sa.Column("max_daily_loss_pct", sa.Numeric(6, 3), server_default="3.0"),
        sa.Column("max_trailing_drawdown_pct", sa.Numeric(6, 3), server_default="6.0"),
        sa.Column("max_position_size", sa.Integer, server_default="3"),
        sa.Column("max_consecutive_losses", sa.Integer, server_default="3"),
        sa.Column("max_daily_trades", sa.Integer, server_default="8"),
    )

    op.create_table(
        "system_state",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("mode", sa.String(16), server_default="analysis_only"),
        sa.Column("kill_switch", sa.Boolean, server_default=sa.false()),
        sa.Column("kill_switch_reason", sa.String(512), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "regime_history",
        sa.Column("time", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("symbol", sa.String(32), primary_key=True),
        sa.Column("trend_label", sa.String(16), nullable=False),
        sa.Column("vol_label", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Numeric(5, 4), nullable=False),
        sa.Column("features", JSONB, server_default="{}"),
    )
    op.create_index("ix_regime_history_symbol_time", "regime_history", ["symbol", "time"])
    op.execute("SELECT create_hypertable('regime_history', 'time', if_not_exists => TRUE)")

    op.create_table(
        "news_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("event_time", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("country", sa.String(8), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("impact", sa.String(16), nullable=False),
        sa.Column("actual", sa.String(64), nullable=True),
        sa.Column("forecast", sa.String(64), nullable=True),
        sa.Column("previous", sa.String(64), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("event_time", "country", "name", name="uq_news_event"),
    )

    op.create_table(
        "trades",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.Integer, sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("symbol", sa.String(32), nullable=False, index=True),
        sa.Column("strategy_id", sa.String(64), nullable=False),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("entry_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("entry_price", sa.Numeric(18, 8), nullable=False),
        sa.Column("stop_price", sa.Numeric(18, 8), nullable=False),
        sa.Column("take_profit_price", sa.Numeric(18, 8), nullable=True),
        sa.Column("exit_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exit_price", sa.Numeric(18, 8), nullable=True),
        sa.Column("exit_reason", sa.String(32), nullable=True),
        sa.Column("pnl", sa.Numeric(18, 2), nullable=True),
        sa.Column("fees", sa.Numeric(18, 2), server_default="0"),
        sa.Column("mae", sa.Numeric(18, 8), nullable=True),
        sa.Column("mfe", sa.Numeric(18, 8), nullable=True),
        sa.Column("score", sa.Numeric(6, 5), nullable=True),
        sa.Column("regime_trend_at_entry", sa.String(16), nullable=True),
        sa.Column("regime_vol_at_entry", sa.String(16), nullable=True),
        sa.Column("explanation", sa.String(2048), server_default=""),
        sa.Column("status", sa.String(16), server_default="open"),
        sa.Column("broker_order_id", sa.String(64), nullable=True),
    )

    op.create_table(
        "scores",
        sa.Column("time", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("symbol", sa.String(32), primary_key=True),
        sa.Column("strategy_id", sa.String(64), primary_key=True),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("probability", sa.Numeric(6, 5), nullable=False),
        sa.Column("decision", sa.String(16), nullable=False),
        sa.Column("features", JSONB, server_default="{}"),
        sa.Column("explanation", sa.String(2048), nullable=False),
        sa.Column("trade_id", sa.Integer, sa.ForeignKey("trades.id"), nullable=True),
    )
    op.create_index("ix_scores_symbol_time", "scores", ["symbol", "time"])
    op.execute("SELECT create_hypertable('scores', 'time', if_not_exists => TRUE)")

    op.create_table(
        "orders",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("trade_id", sa.Integer, sa.ForeignKey("trades.id"), nullable=True),
        sa.Column("broker_order_id", sa.String(64), nullable=True),
        sa.Column("account_id", sa.Integer, sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("symbol", sa.String(32), nullable=False),
        sa.Column("order_type", sa.String(16), nullable=False),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("price", sa.Numeric(18, 8), nullable=True),
        sa.Column("status", sa.String(16), server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("filled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("filled_price", sa.Numeric(18, 8), nullable=True),
    )

    op.create_table(
        "positions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.Integer, sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("symbol", sa.String(32), nullable=False),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("avg_price", sa.Numeric(18, 8), nullable=False),
        sa.Column("unrealized_pnl", sa.Numeric(18, 2), server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("account_id", "symbol", name="uq_position_account_symbol"),
    )

    op.create_table(
        "equity_curve",
        sa.Column("time", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("account_id", sa.Integer, sa.ForeignKey("accounts.id"), primary_key=True),
        sa.Column("equity", sa.Numeric(18, 2), nullable=False),
        sa.Column("balance", sa.Numeric(18, 2), nullable=False),
    )
    op.create_index("ix_equity_curve_account_time", "equity_curve", ["account_id", "time"])
    op.execute("SELECT create_hypertable('equity_curve', 'time', if_not_exists => TRUE)")

    # Continuous aggregates derived from the 1-minute base table.
    for bucket, view in (("5 minutes", "bars_5m"), ("15 minutes", "bars_15m"), ("1 hour", "bars_1h"), ("1 day", "bars_1d")):
        op.execute(
            f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS {view}
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket('{bucket}', time) AS bucket,
                symbol,
                first(open, time) AS open,
                max(high) AS high,
                min(low) AS low,
                last(close, time) AS close,
                sum(volume) AS volume
            FROM bars_1m
            GROUP BY bucket, symbol
            WITH NO DATA
            """
        )
        op.execute(
            f"""
            SELECT add_continuous_aggregate_policy('{view}',
                start_offset => NULL,
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '5 minutes')
            """
        )


def downgrade() -> None:
    for view in ("bars_1d", "bars_1h", "bars_15m", "bars_5m"):
        op.execute(f"DROP MATERIALIZED VIEW IF EXISTS {view} CASCADE")
    op.drop_table("equity_curve")
    op.drop_table("positions")
    op.drop_table("orders")
    op.drop_table("scores")
    op.drop_table("trades")
    op.drop_table("news_events")
    op.drop_table("regime_history")
    op.drop_table("system_state")
    op.drop_table("risk_limits")
    op.drop_table("accounts")
    op.drop_table("bars_1m")
    op.drop_table("bars_daily")
    op.drop_table("instruments")
