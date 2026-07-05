/**
 * Determines how "actionable" a scored setup still is by the time a human
 * looks at it. Tera Trade doesn't execute automatically in analysis_only
 * mode (or even in paper mode without a broker in the loop) -- the operator
 * places the trade manually on TopstepX, so a recommendation has a shelf
 * life: a setup that scored well 45 minutes ago may no longer reflect the
 * current market.
 */
export const ACTIONABLE_FRESH_MINUTES = 15;
export const ACTIONABLE_STALE_MINUTES = 60;

export type Actionability = "fresh" | "stale" | "expired";

export function computeActionability(scoreTime: Date, now: Date = new Date()): Actionability {
  const ageMinutes = (now.getTime() - scoreTime.getTime()) / 60_000;
  if (ageMinutes <= ACTIONABLE_FRESH_MINUTES) return "fresh";
  if (ageMinutes <= ACTIONABLE_STALE_MINUTES) return "stale";
  return "expired";
}
