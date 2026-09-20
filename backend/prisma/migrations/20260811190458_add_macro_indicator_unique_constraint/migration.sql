-- DropIndex
DROP INDEX "macro_indicators_symbol_time_idx";

-- CreateIndex
CREATE UNIQUE INDEX "macro_indicators_symbol_time_key" ON "macro_indicators"("symbol", "time");

