/**
 * TopstepX "Tilt" as a scoring factor for every version v1-v7 (2026-10-06,
 * operator request: "make the tilt part of all of the scoring").
 *
 * Reads both rows together, "trade with the winning side" -- the same rule as
 * the execution gate (risk/tiltGate.ts): longs winning or shorts trapped
 * favors longs; shorts winning or longs trapped favors shorts.
 *
 * Strength is the product of how far each row leans from 50/50:
 *
 *   s = ((% Long - 50) / 50) x ((% Positive - 50) / 50)      in [-1, 1]
 *   long points  = TILT_MAX_POINTS x sign(s) x sqrt(|s|);    short = the negative
 *
 * s > 0 means longs are winning or shorts are trapped. The square root keeps
 * typical readings meaningful: 62% long / 58% positive -> +3.9 for a long,
 * 73% / 65% -> +7.4, a 100/100 extreme -> +20 (on the 0-100 score scale).
 *
 * This is a soft factor on the score. The hard execution rule (the Tilt must
 * favor the trade's side, risk/tiltGate.ts) is separate and still applies.
 *
 * Pure, no wall clock: freshness is judged against the decision's own bar
 * time `at`, so replay stays deterministic. Replay has no Tilt feed
 * (ReplayDecisionContext.orderFlow() is null), so it always scores 0 here --
 * the same for live with no fresh reading.
 */
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";
import { tiltFavoredSide, tiltReading } from "../risk/tiltGate.js";

export const TILT_MAX_POINTS = 20;
/** A reading older than this relative to the bar being decided is ignored. */
export const TILT_SCORING_MAX_AGE_MS = 3 * 60_000;

export interface TiltAdjustment {
  adjustmentPoints: number;
  description: string;
}

export function computeTiltAdjustment(snapshot: OrderFlowSnapshot | null, side: "long" | "short", at: Date): TiltAdjustment {
  const reading = tiltReading(snapshot);
  const updatedAt = snapshot?.tiltUpdatedAtMs ?? null;
  if (reading === null || updatedAt === null) {
    return { adjustmentPoints: 0, description: "no TopstepX Tilt reading -- no Tilt adjustment" };
  }
  if (at.getTime() - updatedAt > TILT_SCORING_MAX_AGE_MS) {
    return { adjustmentPoints: 0, description: "TopstepX Tilt reading is stale for this bar -- no Tilt adjustment" };
  }
  const s = ((reading.longPct - 50) / 50) * ((reading.positivePct - 50) / 50);
  const longPoints = TILT_MAX_POINTS * Math.sign(s) * Math.sqrt(Math.abs(s));
  const raw = side === "long" ? longPoints : -longPoints;
  const adjustmentPoints = Math.round(Math.max(-TILT_MAX_POINTS, Math.min(TILT_MAX_POINTS, raw)) * 10) / 10;
  const sign = adjustmentPoints >= 0 ? "+" : "";
  return {
    adjustmentPoints,
    description: `TopstepX Tilt: ${tiltFavoredSide(reading).read} -- ${side} ${sign}${adjustmentPoints.toFixed(1)} pts`,
  };
}

/** Applies a Tilt adjustment to a 0-1 probability (the scale v1/v2/v4/v5/v6/v7 use). */
export function applyTiltToProbability(probability: number, tilt: TiltAdjustment): number {
  const adjusted = Math.max(0, Math.min(1, probability + tilt.adjustmentPoints / 100));
  return Math.round(adjusted * 1e5) / 1e5;
}
