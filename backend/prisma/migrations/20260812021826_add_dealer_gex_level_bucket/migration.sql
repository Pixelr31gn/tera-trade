-- AlterTable
ALTER TABLE "dealer_gex_levels" ADD COLUMN     "bucket" TEXT NOT NULL DEFAULT 'blended';

-- CreateIndex
CREATE INDEX "dealer_gex_levels_symbol_bucket_time_idx" ON "dealer_gex_levels"("symbol", "bucket", "time");

