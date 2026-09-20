-- Reverts 20260812145439_add_ema_crossover_gate: the operator cancelled the
-- gate/toggle plan in favor of using the underlying 20/200 EMA calculation
-- as a scoring input across v1-v7 instead of a hard risk-engine veto -- see
-- analytics/emaTrend.ts's computeEma20Ema200Regime.
ALTER TABLE "system_state" DROP COLUMN "ema_crossover_gate_enabled";
