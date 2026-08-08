-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "entry_quality_score" DECIMAL(6,2),
ADD COLUMN     "time_to_fill_seconds" INTEGER;
