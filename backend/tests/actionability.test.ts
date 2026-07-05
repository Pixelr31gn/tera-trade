import { describe, expect, it } from "vitest";
import { ACTIONABLE_FRESH_MINUTES, ACTIONABLE_STALE_MINUTES, computeActionability } from "../src/scoring/actionability.js";

const NOW = new Date("2026-07-05T12:00:00Z");

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe("computeActionability", () => {
  it("is fresh right when it happens and up to the fresh threshold", () => {
    expect(computeActionability(minutesAgo(0), NOW)).toBe("fresh");
    expect(computeActionability(minutesAgo(ACTIONABLE_FRESH_MINUTES), NOW)).toBe("fresh");
  });

  it("becomes stale just after the fresh threshold, up to the stale threshold", () => {
    expect(computeActionability(minutesAgo(ACTIONABLE_FRESH_MINUTES + 1), NOW)).toBe("stale");
    expect(computeActionability(minutesAgo(ACTIONABLE_STALE_MINUTES), NOW)).toBe("stale");
  });

  it("expires beyond the stale threshold", () => {
    expect(computeActionability(minutesAgo(ACTIONABLE_STALE_MINUTES + 1), NOW)).toBe("expired");
    expect(computeActionability(minutesAgo(1000), NOW)).toBe("expired");
  });
});
