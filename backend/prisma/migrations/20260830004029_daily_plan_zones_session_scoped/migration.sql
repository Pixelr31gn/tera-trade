/*
  Warnings:

  - You are about to drop the column `trading_date` on the `daily_plan_zones` table. All the data in the column will be lost.
  - Added the required column `session_start` to the `daily_plan_zones` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "daily_plan_zones_symbol_trading_date_idx";

-- AlterTable
ALTER TABLE "daily_plan_zones" DROP COLUMN "trading_date",
ADD COLUMN     "session_start" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "daily_plan_zones_symbol_session_start_idx" ON "daily_plan_zones"("symbol", "session_start");
