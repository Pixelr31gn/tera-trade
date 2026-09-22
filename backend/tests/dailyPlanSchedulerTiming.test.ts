import { describe, expect, it } from "vitest";
import { getSessionEnd, getSessionStart } from "../src/analytics/session.js";
import { POLL_INTERVAL_MS, PRE_TRIGGER_WINDOW_MS } from "../src/assistant/dailyPlanScheduler.js";

/**
 * 2026-09-21, operator request: "10 minutes before each session a daily
 * trading plan is made then set."
 *
 * These two constants have to be chosen together, and the comment saying so
 * is not enough on its own -- the window alone does NOT determine when the
 * refresh lands. The first tick that falls inside the window triggers it and
 * then lastHandledSessionStart suppresses the rest, so the poll interval is
 * what pins the refresh to the TOP of the window. A 5-minute poll against a
 * 10-minute window (the state this replaced) would fire anywhere from 10 to
 * 5 minutes out.
 *
 * This file tests that relationship arithmetically rather than by running the
 * scheduler: maybeRefreshForNewSession is private, DB-coupled and LLM-coupled,
 * so the timing rule is the part worth guarding independently.
 */
describe("daily-plan scheduler pre-trigger timing", () => {
  const MINUTE = 60 * 1000;

  it("opens the pre-trigger window 10 minutes before the boundary", () => {
    expect(PRE_TRIGGER_WINDOW_MS).toBe(10 * MINUTE);
  });

  it("polls often enough that the refresh lands within a minute of the window opening", () => {
    // The worst case is a tick landing just before the window opens: the next
    // one is POLL_INTERVAL_MS later, so the refresh starts at most that far
    // inside the window. Anything above a minute stops "10 minutes before"
    // from being meaningfully true.
    expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(MINUTE);
    expect(PRE_TRIGGER_WINDOW_MS - POLL_INTERVAL_MS).toBeGreaterThanOrEqual(9 * MINUTE);
  });

  it("leaves room for a slow refresh to finish before the boundary it exists to beat", () => {
    // buildContextDigest plus two Gemini round-trips measured ~40s on a good
    // run and over 2 minutes through the retry path on 2026-09-21. The window
    // must comfortably exceed that, or the pre-trigger finishes after the
    // session has already started and the gate it was racing is already live.
    const OBSERVED_SLOW_REFRESH_MS = 3 * MINUTE;
    expect(PRE_TRIGGER_WINDOW_MS - POLL_INTERVAL_MS).toBeGreaterThan(OBSERVED_SLOW_REFRESH_MS);
  });

  /**
   * Walks real wall-clock minutes across a full day and asserts that for every
   * session boundary the scheduler's own condition
   * (`msUntilUpcoming >= 0 && msUntilUpcoming <= PRE_TRIGGER_WINDOW_MS`)
   * becomes true at some tick, and that the FIRST such tick is between 9 and
   * 10 minutes before the boundary. Uses analytics/session.ts directly so the
   * real New York / London / Asian boundaries are the ones under test, not a
   * hand-listed set that could drift from them.
   */
  it("fires once per session, 9-10 minutes ahead, for every real boundary in a day", () => {
    const start = Date.UTC(2026, 8, 22, 0, 0, 0); // 2026-09-22T00:00:00Z
    const dayEnd = start + 24 * 60 * MINUTE;

    // sessionStart -> minutes-before-boundary at which the refresh first fired.
    const firedAt = new Map<number, number>();
    let lastHandledSessionStart: number | null = null;

    for (let t = start; t < dayEnd; t += POLL_INTERVAL_MS) {
      const now = new Date(t);
      const upcoming = getSessionEnd(now); // start of the NEXT session in sequence
      const msUntil = upcoming.getTime() - now.getTime();

      const inWindow = msUntil >= 0 && msUntil <= PRE_TRIGGER_WINDOW_MS;
      if (!inWindow) continue;
      if (upcoming.getTime() === lastHandledSessionStart) continue; // already handled

      lastHandledSessionStart = upcoming.getTime();
      firedAt.set(upcoming.getTime(), msUntil / MINUTE);
    }

    // Three boundaries a day (NY 13:00, Asian 22:00, London 08:00 UTC).
    expect(firedAt.size).toBe(3);

    for (const [sessionStart, minutesBefore] of firedAt) {
      const label = new Date(sessionStart).toISOString();
      expect(minutesBefore, label).toBeLessThanOrEqual(10);
      expect(minutesBefore, label).toBeGreaterThan(9 - 1e-9);
    }

    // And every boundary that fired is a real session start, not an artifact
    // of the sweep.
    for (const sessionStart of firedAt.keys()) {
      const justAfter = new Date(sessionStart + MINUTE);
      expect(getSessionStart(justAfter).getTime(), new Date(sessionStart).toISOString()).toBe(sessionStart);
    }
  });
});
