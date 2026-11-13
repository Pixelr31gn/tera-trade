-- Reverts 20261019070000_add_tilt_gate_enabled (2026-10-20, operator: revert the last 3 days of changes).
ALTER TABLE "system_state" DROP COLUMN "tilt_gate_enabled";
