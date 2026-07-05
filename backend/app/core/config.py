"""Central application configuration, loaded from environment / .env."""
from __future__ import annotations

from enum import StrEnum
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class TradingMode(StrEnum):
    ANALYSIS_ONLY = "analysis_only"
    PAPER = "paper"
    LIVE = "live"


class BrokerKind(StrEnum):
    SIMULATED = "simulated"
    PROJECTX = "projectx"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- App ---
    app_name: str = "Terra Trade"
    environment: str = "development"
    log_level: str = "INFO"
    api_key: str = Field(default="change-me-dev-key", description="Static API key required on all /api routes")

    # --- Database ---
    database_url: str = Field(
        default="postgresql+asyncpg://terra:terra@localhost:5432/terra_trade",
        description="Async SQLAlchemy URL for the TimescaleDB/Postgres instance",
    )

    # --- Trading mode / broker ---
    trading_mode: TradingMode = TradingMode.ANALYSIS_ONLY
    broker_kind: BrokerKind = BrokerKind.SIMULATED
    live_trading_confirmed: bool = Field(
        default=False,
        description="Must be explicitly set true (separately from trading_mode) before LIVE mode can route real orders",
    )

    # --- ProjectX Gateway (Topstep) ---
    projectx_base_url: str = "https://api.topstepx.com"
    projectx_rtc_url: str = "https://rtc.topstepx.com"
    projectx_username: str = ""
    projectx_api_key: str = ""
    projectx_account_id: int | None = None

    # --- Instruments ---
    instrument_symbols: list[str] = Field(default_factory=lambda: ["ES=F", "NQ=F", "CL=F", "GC=F"])

    # --- Historical backfill ---
    historical_backfill_days: int = 365
    bar_interval_minutes: int = 1

    # --- News / calendar ---
    news_calendar_url: str = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
    news_risk_window_minutes: int = 15
    news_high_impact_only: bool = True

    # --- Scoring ---
    min_score_threshold: float = Field(default=0.65, ge=0.0, le=1.0)

    # --- Risk defaults (overridable per-account via risk_limits table) ---
    default_per_trade_risk_pct: float = Field(default=0.5, description="% of account equity risked per trade")
    default_max_daily_loss_pct: float = Field(default=3.0)
    default_max_trailing_drawdown_pct: float = Field(default=6.0)
    default_max_position_size: int = Field(default=3, description="Max contracts per instrument")
    max_consecutive_losses: int = Field(default=3)
    max_daily_trades: int = Field(default=8)

    # --- Engine loop ---
    engine_poll_seconds: float = 5.0

    @field_validator("instrument_symbols", mode="before")
    @classmethod
    def _split_symbols(cls, v: object) -> object:
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
