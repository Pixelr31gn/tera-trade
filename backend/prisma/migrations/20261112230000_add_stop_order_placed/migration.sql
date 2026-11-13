-- Hard stop: a real broker-side Stop Market order is resting for this trade (2026-11-12).
ALTER TABLE "trades" ADD COLUMN "stop_order_placed" BOOLEAN NOT NULL DEFAULT false;
