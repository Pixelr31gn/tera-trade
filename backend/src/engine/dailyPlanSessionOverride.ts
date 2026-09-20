/**
 * Shared "which session should a daily-plan write be scoped to" override
 * (2026-08-31, operator request: "better to trigger 5 minutes before the
 * session" -- dailyPlanScheduler.ts now pre-builds the UPCOMING session's
 * plan a few minutes early so it's already in effect the instant that
 * session starts, rather than leaving a gap right at the boundary where the
 * new session has zero zones until the first post-boundary poll catches it.
 *
 * The problem this solves: assistant/tools.ts's set_daily_plan_zones and
 * set_daily_take_profit_target handlers otherwise always scope a write to
 * whatever session real "now" falls in (dailyPlanZoneCache.ts's
 * getSessionStart(new Date())) -- during the pre-trigger window, that's
 * still the OLD session, so a write there would land on the wrong session's
 * rows entirely. The scheduler sets this override to the upcoming session's
 * start immediately before triggering the assistant call, and clears it
 * right after (success or failure) -- a manual operator chat request never
 * touches this, so it's unaffected and keeps scoping to real "now" exactly
 * as before this existed.
 */
let overrideAt: Date | null = null;

export function setDailyPlanSessionOverride(at: Date | null): void {
  overrideAt = at;
}

/** The effective "at" a daily-plan write handler should use -- the scheduler's active pre-trigger override, or real current time otherwise. */
export function resolveDailyPlanAt(): Date {
  return overrideAt ?? new Date();
}
