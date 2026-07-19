-- AlterTable
ALTER TABLE "scores" ADD COLUMN     "liquidity_label" TEXT,
ADD COLUMN     "market_structure_label" TEXT,
ADD COLUMN     "price_action_label" TEXT;

-- CreateIndex
CREATE INDEX "scores_time_session_idx" ON "scores"("time", "session");

