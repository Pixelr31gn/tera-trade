-- AlterTable
ALTER TABLE "scores" ADD COLUMN     "atr_at_signal" DECIMAL(18,8) NOT NULL,
ADD COLUMN     "entry_price_at_signal" DECIMAL(18,8) NOT NULL,
ADD COLUMN     "outcome_evaluated_at" TIMESTAMP(3),
ADD COLUMN     "outcome_label" TEXT,
ADD COLUMN     "outcome_r_multiple" DECIMAL(8,3),
ADD COLUMN     "risk_reward_ratio" DECIMAL(6,3),
ADD COLUMN     "session" TEXT NOT NULL,
ADD COLUMN     "structure_swing_price_at_signal" DECIMAL(18,8);

-- CreateIndex
CREATE INDEX "scores_session_outcome_label_idx" ON "scores"("session", "outcome_label");

