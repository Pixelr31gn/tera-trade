-- AlterTable
ALTER TABLE "scores" DROP CONSTRAINT "scores_pkey",
ADD COLUMN     "acknowledged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "acknowledged_at" TIMESTAMP(3),
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "scores_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "scores_decision_acknowledged_time_idx" ON "scores"("decision", "acknowledged", "time");

-- CreateIndex
CREATE UNIQUE INDEX "scores_time_symbol_strategy_id_key" ON "scores"("time", "symbol", "strategy_id");

