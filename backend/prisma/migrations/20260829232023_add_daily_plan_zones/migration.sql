-- CreateTable
CREATE TABLE "daily_plan_zones" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "trading_date" DATE NOT NULL,
    "price_low" DECIMAL(18,8) NOT NULL,
    "price_high" DECIMAL(18,8) NOT NULL,
    "enforcement" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_plan_zones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_plan_zones_symbol_trading_date_idx" ON "daily_plan_zones"("symbol", "trading_date");
