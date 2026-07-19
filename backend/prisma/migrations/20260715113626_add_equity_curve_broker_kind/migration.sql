-- Add broker_kind to equity_curve, defaulting existing rows to 'simulated'
-- (their true origin can't be reconstructed after the fact -- SystemState
-- never kept a timestamped mode-change history -- so this is a neutral
-- placeholder, not a claim of accuracy for historical rows). Going forward,
-- every new point is correctly labeled at write time (see engine/loop.ts).
ALTER TABLE "equity_curve" ADD COLUMN "broker_kind" TEXT NOT NULL DEFAULT 'simulated';

ALTER TABLE "equity_curve" DROP CONSTRAINT "equity_curve_pkey";
ALTER TABLE "equity_curve" ADD CONSTRAINT "equity_curve_pkey" PRIMARY KEY ("time", "account_id", "broker_kind");

DROP INDEX IF EXISTS "equity_curve_account_id_time_idx";
CREATE INDEX "equity_curve_account_id_broker_kind_time_idx" ON "equity_curve"("account_id", "broker_kind", "time");
