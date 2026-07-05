-- CreateTable
CREATE TABLE "instruments" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "data_symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'CME',
    "contract_id" TEXT,
    "tick_size" DECIMAL(18,8) NOT NULL,
    "point_value" DECIMAL(18,8) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bars_1m" (
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "open" DECIMAL(18,8) NOT NULL,
    "high" DECIMAL(18,8) NOT NULL,
    "low" DECIMAL(18,8) NOT NULL,
    "close" DECIMAL(18,8) NOT NULL,
    "volume" DECIMAL(20,4) NOT NULL DEFAULT 0,

    CONSTRAINT "bars_1m_pkey" PRIMARY KEY ("time","symbol")
);

-- CreateTable
CREATE TABLE "bars_rollup" (
    "bucket" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "open" DECIMAL(18,8) NOT NULL,
    "high" DECIMAL(18,8) NOT NULL,
    "low" DECIMAL(18,8) NOT NULL,
    "close" DECIMAL(18,8) NOT NULL,
    "volume" DECIMAL(20,4) NOT NULL DEFAULT 0,

    CONSTRAINT "bars_rollup_pkey" PRIMARY KEY ("resolution","symbol","bucket")
);

-- CreateTable
CREATE TABLE "bars_daily" (
    "date" DATE NOT NULL,
    "symbol" TEXT NOT NULL,
    "open" DECIMAL(18,8) NOT NULL,
    "high" DECIMAL(18,8) NOT NULL,
    "low" DECIMAL(18,8) NOT NULL,
    "close" DECIMAL(18,8) NOT NULL,
    "volume" DECIMAL(20,4) NOT NULL DEFAULT 0,

    CONSTRAINT "bars_daily_pkey" PRIMARY KEY ("date","symbol")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" SERIAL NOT NULL,
    "broker_account_id" TEXT,
    "name" TEXT NOT NULL DEFAULT 'default',
    "starting_balance" DECIMAL(18,2) NOT NULL DEFAULT 50000,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_limits" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "per_trade_risk_pct" DECIMAL(6,3) NOT NULL DEFAULT 0.5,
    "max_daily_loss_pct" DECIMAL(6,3) NOT NULL DEFAULT 3.0,
    "max_trailing_drawdown_pct" DECIMAL(6,3) NOT NULL DEFAULT 6.0,
    "max_position_size" INTEGER NOT NULL DEFAULT 3,
    "max_consecutive_losses" INTEGER NOT NULL DEFAULT 3,
    "max_daily_trades" INTEGER NOT NULL DEFAULT 8,

    CONSTRAINT "risk_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mode" TEXT NOT NULL DEFAULT 'analysis_only',
    "kill_switch" BOOLEAN NOT NULL DEFAULT false,
    "kill_switch_reason" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regime_history" (
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "trend_label" TEXT NOT NULL,
    "vol_label" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "features" JSONB NOT NULL,

    CONSTRAINT "regime_history_pkey" PRIMARY KEY ("time","symbol")
);

-- CreateTable
CREATE TABLE "news_events" (
    "id" SERIAL NOT NULL,
    "event_time" TIMESTAMP(3) NOT NULL,
    "country" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "actual" TEXT,
    "forecast" TEXT,
    "previous" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scores" (
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "probability" DECIMAL(6,5) NOT NULL,
    "decision" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "trade_id" INTEGER,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("time","symbol","strategy_id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "entry_time" TIMESTAMP(3) NOT NULL,
    "entry_price" DECIMAL(18,8) NOT NULL,
    "stop_price" DECIMAL(18,8) NOT NULL,
    "take_profit_price" DECIMAL(18,8),
    "exit_time" TIMESTAMP(3),
    "exit_price" DECIMAL(18,8),
    "exit_reason" TEXT,
    "pnl" DECIMAL(18,2),
    "fees" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "mae" DECIMAL(18,8),
    "mfe" DECIMAL(18,8),
    "score" DECIMAL(6,5),
    "regime_trend_at_entry" TEXT,
    "regime_vol_at_entry" TEXT,
    "explanation" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "broker_order_id" TEXT,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "trade_id" INTEGER,
    "broker_order_id" TEXT,
    "account_id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "order_type" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(18,8),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filled_at" TIMESTAMP(3),
    "filled_price" DECIMAL(18,8),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "avg_price" DECIMAL(18,8) NOT NULL,
    "unrealized_pnl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equity_curve" (
    "time" TIMESTAMP(3) NOT NULL,
    "account_id" INTEGER NOT NULL,
    "equity" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "equity_curve_pkey" PRIMARY KEY ("time","account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instruments_symbol_key" ON "instruments"("symbol");

-- CreateIndex
CREATE INDEX "bars_1m_symbol_time_idx" ON "bars_1m"("symbol", "time");

-- CreateIndex
CREATE INDEX "bars_rollup_resolution_symbol_bucket_idx" ON "bars_rollup"("resolution", "symbol", "bucket");

-- CreateIndex
CREATE INDEX "bars_daily_symbol_date_idx" ON "bars_daily"("symbol", "date");

-- CreateIndex
CREATE UNIQUE INDEX "risk_limits_account_id_key" ON "risk_limits"("account_id");

-- CreateIndex
CREATE INDEX "regime_history_symbol_time_idx" ON "regime_history"("symbol", "time");

-- CreateIndex
CREATE INDEX "news_events_event_time_idx" ON "news_events"("event_time");

-- CreateIndex
CREATE UNIQUE INDEX "news_events_event_time_country_name_key" ON "news_events"("event_time", "country", "name");

-- CreateIndex
CREATE INDEX "scores_symbol_time_idx" ON "scores"("symbol", "time");

-- CreateIndex
CREATE INDEX "trades_symbol_idx" ON "trades"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "positions_account_id_symbol_key" ON "positions"("account_id", "symbol");

-- CreateIndex
CREATE INDEX "equity_curve_account_id_time_idx" ON "equity_curve"("account_id", "time");

-- AddForeignKey
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equity_curve" ADD CONSTRAINT "equity_curve_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
