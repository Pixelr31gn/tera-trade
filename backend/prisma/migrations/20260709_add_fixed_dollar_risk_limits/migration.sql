-- AlterTable
ALTER TABLE "risk_limits" ADD COLUMN     "max_daily_loss_dollars" DECIMAL(10,2),
ADD COLUMN     "per_trade_profit_dollars" DECIMAL(10,2),
ADD COLUMN     "per_trade_risk_dollars" DECIMAL(10,2);

