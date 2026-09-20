-- AlterTable
ALTER TABLE "scores" ADD COLUMN     "context_bucket" TEXT;

-- CreateIndex
CREATE INDEX "scores_strategy_version_context_bucket_time_idx" ON "scores"("strategy_version", "context_bucket", "time");
