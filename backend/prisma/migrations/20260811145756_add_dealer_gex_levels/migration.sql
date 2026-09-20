-- CreateTable
CREATE TABLE "dealer_gex_levels" (
    "id" SERIAL NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "spot_price" DECIMAL(18,8) NOT NULL,
    "call_wall" DECIMAL(18,8),
    "put_wall" DECIMAL(18,8),
    "gamma_flip" DECIMAL(18,8),
    "call_wall_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "put_wall_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dealer_gex_levels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dealer_gex_levels_symbol_time_idx" ON "dealer_gex_levels"("symbol", "time");
