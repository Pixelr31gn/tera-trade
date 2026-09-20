-- CreateTable
CREATE TABLE "shadow_gex_signals" (
    "id" SERIAL NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "close_price" DECIMAL(18,8) NOT NULL,
    "call_wall" DECIMAL(18,8),
    "put_wall" DECIMAL(18,8),
    "gamma_flip" DECIMAL(18,8),
    "gex_regime" TEXT NOT NULL,
    "consensus_taken" BOOLEAN NOT NULL,
    "consensus_average_probability" DECIMAL(6,5) NOT NULL,
    "version_scores" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shadow_gex_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shadow_gex_signals_symbol_time_idx" ON "shadow_gex_signals"("symbol", "time");

-- CreateIndex
CREATE INDEX "shadow_gex_signals_gex_regime_consensus_taken_idx" ON "shadow_gex_signals"("gex_regime", "consensus_taken");
