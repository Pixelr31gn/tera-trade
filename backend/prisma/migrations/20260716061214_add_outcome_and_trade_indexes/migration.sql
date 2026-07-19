-- CreateIndex
CREATE INDEX "scores_outcome_label_trade_id_idx" ON "scores"("outcome_label", "trade_id");

-- CreateIndex
CREATE INDEX "trades_account_id_status_broker_kind_idx" ON "trades"("account_id", "status", "broker_kind");
