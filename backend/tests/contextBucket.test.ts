import { describe, expect, it } from "vitest";
import { computeContextBucket } from "../src/analytics/contextBucket.js";
import { TradingSession } from "../src/analytics/session.js";

const SESSIONS = [TradingSession.NEW_YORK, TradingSession.LONDON, TradingSession.ASIAN] as const;
const TREND_LABELS = ["up", "down", "none"] as const;
const VOL_LABELS = ["high", "normal", "low"] as const;

describe("computeContextBucket", () => {
  it("produces a colon-joined key for every session x trend x vol combination", () => {
    const seen = new Set<string>();
    for (const session of SESSIONS) {
      for (const trendLabel of TREND_LABELS) {
        for (const volLabel of VOL_LABELS) {
          const bucket = computeContextBucket(session, trendLabel, volLabel);
          expect(bucket).toBe(`${session}:${trendLabel}:${volLabel}`);
          seen.add(bucket);
        }
      }
    }
    // 3 sessions x 3 trend labels x 3 vol labels -- every combination must be
    // a distinct key, or two different market conditions would silently
    // share one bandit bucket.
    expect(seen.size).toBe(27);
  });

  it("is order-sensitive (session/trend/vol aren't interchangeable)", () => {
    expect(computeContextBucket(TradingSession.LONDON, "up", "high")).not.toBe(
      computeContextBucket(TradingSession.NEW_YORK, "up", "high")
    );
    expect(computeContextBucket(TradingSession.LONDON, "up", "high")).not.toBe(
      computeContextBucket(TradingSession.LONDON, "down", "high")
    );
  });
});
