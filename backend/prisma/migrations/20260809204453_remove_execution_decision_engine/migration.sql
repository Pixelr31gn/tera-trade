-- AlterTable
ALTER TABLE "system_state" DROP COLUMN "entry_ladder_quality_enabled",
DROP COLUMN "execution_decision_engine_enabled";

-- AlterTable
ALTER TABLE "trades" DROP COLUMN "entry_quality_score",
DROP COLUMN "time_to_fill_seconds";
