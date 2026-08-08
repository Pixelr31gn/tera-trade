-- DropForeignKey
ALTER TABLE "positions" DROP CONSTRAINT "positions_account_id_fkey";

-- AlterTable
ALTER TABLE "news_events" DROP COLUMN "actual";

-- DropTable
DROP TABLE "bars_rollup";

-- DropTable
DROP TABLE "order_flow_snapshots";

-- DropTable
DROP TABLE "positions";

-- DropTable
DROP TABLE "regime_history";

