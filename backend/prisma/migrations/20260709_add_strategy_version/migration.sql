-- DropIndex
DROP INDEX "scores_time_symbol_strategy_id_key";

-- AlterTable
ALTER TABLE "scores" ADD COLUMN     "strategy_version" TEXT NOT NULL DEFAULT 'v1';

-- AlterTable
ALTER TABLE "system_state" ADD COLUMN     "active_strategy_version" TEXT NOT NULL DEFAULT 'v1';

-- CreateIndex
CREATE INDEX "scores_strategy_version_session_outcome_label_idx" ON "scores"("strategy_version", "session", "outcome_label");

-- CreateIndex
CREATE UNIQUE INDEX "scores_time_symbol_strategy_id_strategy_version_key" ON "scores"("time", "symbol", "strategy_id", "strategy_version");

