-- CreateTable
CREATE TABLE "order_flow_snapshots" (
    "id" SERIAL NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "best_bid_size" DECIMAL(18,4),
    "best_ask_size" DECIMAL(18,4),
    "buy_volume" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sell_volume" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "trade_count" INTEGER NOT NULL DEFAULT 0,
    "tilt_long_bias" DECIMAL(9,5),
    "tilt_short_bias" DECIMAL(9,5),

    CONSTRAINT "order_flow_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_flow_snapshots_symbol_time_idx" ON "order_flow_snapshots"("symbol", "time");

