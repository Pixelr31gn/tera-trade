import { describe, expect, it } from "vitest";
import { computeScore } from "../src/scout/ranking.js";
import { slugify } from "../src/scout/pitchStore.js";

describe("scout ranking", () => {
  const now = new Date("2026-09-03T00:00:00Z");

  it("increases with occurrence count", () => {
    const low = computeScore({ occurrenceCount: 1, lastSeenAt: now, rating: null }, now);
    const high = computeScore({ occurrenceCount: 10, lastSeenAt: now, rating: null }, now);
    expect(high).toBeGreaterThan(low);
  });

  it("decays with staleness", () => {
    const fresh = computeScore({ occurrenceCount: 5, lastSeenAt: now, rating: null }, now);
    const stale = computeScore({ occurrenceCount: 5, lastSeenAt: new Date("2026-08-01T00:00:00Z"), rating: null }, now);
    expect(stale).toBeLessThan(fresh);
  });

  it("a 5-star rating outranks an unrated pitch with the same occurrence/recency", () => {
    const unrated = computeScore({ occurrenceCount: 5, lastSeenAt: now, rating: null }, now);
    const fiveStar = computeScore({ occurrenceCount: 5, lastSeenAt: now, rating: 5 }, now);
    const oneStar = computeScore({ occurrenceCount: 5, lastSeenAt: now, rating: 1 }, now);
    expect(fiveStar).toBeGreaterThan(unrated);
    expect(oneStar).toBeLessThan(unrated);
  });

  it("a stale but highly-rated pitch can still outrank a fresh unrated one -- resurfacing", () => {
    const staleFiveStar = computeScore({ occurrenceCount: 8, lastSeenAt: new Date("2026-08-20T00:00:00Z"), rating: 5 }, now);
    const freshUnrated = computeScore({ occurrenceCount: 2, lastSeenAt: now, rating: null }, now);
    expect(staleFiveStar).toBeGreaterThan(freshUnrated);
  });
});

describe("scout slugify", () => {
  it("produces a stable, url-safe dedupe key", () => {
    expect(slugify("Repeated ts-node build errors on Windows paths")).toBe("repeated-ts-node-build-errors-on-windows-paths");
  });

  it("collapses punctuation and casing differences to the same key", () => {
    expect(slugify("Fix the CI!")).toBe(slugify("fix the ci"));
  });
});
