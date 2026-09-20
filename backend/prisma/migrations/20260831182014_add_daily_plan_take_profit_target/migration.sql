-- CreateTable
CREATE TABLE "daily_plan_take_profit_targets" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "session_start" TIMESTAMP(3) NOT NULL,
    "likely_move_points" DECIMAL(18,8) NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_plan_take_profit_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_plan_take_profit_targets_symbol_session_start_idx" ON "daily_plan_take_profit_targets"("symbol", "session_start");
