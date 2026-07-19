-- AlterTable
ALTER TABLE "scores" ADD COLUMN     "v3_bucket" TEXT;

-- CreateIndex
CREATE INDEX "scores_strategy_version_v3_bucket_time_idx" ON "scores"("strategy_version", "v3_bucket", "time");

