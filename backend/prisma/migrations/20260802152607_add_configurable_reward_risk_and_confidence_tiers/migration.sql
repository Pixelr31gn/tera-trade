-- AlterTable
ALTER TABLE "system_state" ADD COLUMN     "confidence_tier_1_quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "confidence_tier_1_threshold" DECIMAL(65,30) NOT NULL DEFAULT 0.65,
ADD COLUMN     "confidence_tier_2_quantity" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "confidence_tier_2_threshold" DECIMAL(65,30) NOT NULL DEFAULT 0.75,
ADD COLUMN     "confidence_tier_3_quantity" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "confidence_tier_3_threshold" DECIMAL(65,30) NOT NULL DEFAULT 0.85,
ADD COLUMN     "take_profit_r_multiple" DECIMAL(65,30) NOT NULL DEFAULT 3.0;
