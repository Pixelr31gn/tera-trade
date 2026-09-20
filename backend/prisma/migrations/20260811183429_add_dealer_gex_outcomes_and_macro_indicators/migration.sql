-- AlterTable
ALTER TABLE "dealer_gex_levels" ADD COLUMN     "call_wall_outcome" TEXT,
ADD COLUMN     "gamma_flip_outcome" TEXT,
ADD COLUMN     "outcome_evaluated_at" TIMESTAMP(3),
ADD COLUMN     "put_wall_outcome" TEXT;

-- CreateTable
CREATE TABLE "macro_indicators" (
    "id" SERIAL NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "value" DECIMAL(10,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "macro_indicators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "macro_indicators_symbol_time_idx" ON "macro_indicators"("symbol", "time");

-- CreateIndex
CREATE INDEX "dealer_gex_levels_outcome_evaluated_at_idx" ON "dealer_gex_levels"("outcome_evaluated_at");
