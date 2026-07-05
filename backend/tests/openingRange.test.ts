import { describe, expect, it } from "vitest";
import { computeOpeningRangeStats } from "../src/analytics/openingRange.js";
import type { OhlcBar } from "../src/regime/indicators.js";

// January dates are always US Eastern Standard Time (UTC-5), so 9:30am ET is
// reliably 14:30 UTC with no DST ambiguity to worry about in test fixtures.
const ET_OFFSET_HOURS = 5;

function etBar(day: number, hourET: number, minuteET: number, high: number, low: number): OhlcBar {
  const time = new Date(Date.UTC(2026, 0, day, hourET + ET_OFFSET_HOURS, minuteET));
  const close = (high + low) / 2;
  return { time, open: close, high, low, close, volume: 100 };
}

const RTH_OPEN_HOUR = 9;
const RTH_OPEN_MINUTE = 30;

describe("computeOpeningRangeStats", () => {
  it("counts a day where the later session breaks above the opening range high", () => {
    const bars: OhlcBar[] = [
      etBar(5, 9, 30, 101, 99), // opening range: high=101 low=99
      etBar(5, 10, 0, 100.5, 99.5),
      etBar(5, 11, 0, 105, 100), // later session breaks the high (105 > 101)
      etBar(5, 12, 0, 104, 102),
    ];
    const stats = computeOpeningRangeStats(bars, "ES", RTH_OPEN_HOUR, RTH_OPEN_MINUTE);
    expect(stats.sessionsAnalyzed).toBe(1);
    expect(stats.probHighBroken).toBe(1);
    expect(stats.probLowBroken).toBe(0);
  });

  it("counts a day where the later session breaks below the opening range low", () => {
    const bars: OhlcBar[] = [
      etBar(6, 9, 30, 101, 99),
      etBar(6, 10, 0, 100, 99.5),
      etBar(6, 11, 0, 100, 95), // later session breaks the low (95 < 99)
      etBar(6, 12, 0, 98, 96),
    ];
    const stats = computeOpeningRangeStats(bars, "ES", RTH_OPEN_HOUR, RTH_OPEN_MINUTE);
    expect(stats.probHighBroken).toBe(0);
    expect(stats.probLowBroken).toBe(1);
  });

  it("counts a day where neither the high nor the low breaks", () => {
    const bars: OhlcBar[] = [
      etBar(7, 9, 30, 101, 99),
      etBar(7, 10, 0, 100.5, 99.5),
      etBar(7, 11, 0, 100.8, 99.7), // stays inside [99, 101] all day
      etBar(7, 12, 0, 100.2, 99.9),
    ];
    const stats = computeOpeningRangeStats(bars, "ES", RTH_OPEN_HOUR, RTH_OPEN_MINUTE);
    expect(stats.probHighBroken).toBe(0);
    expect(stats.probLowBroken).toBe(0);
    expect(stats.probNeitherBroken).toBe(1);
  });

  it("aggregates probabilities correctly across multiple sessions", () => {
    const bars: OhlcBar[] = [
      // Day 5: breaks high only
      etBar(5, 9, 30, 101, 99),
      etBar(5, 11, 0, 105, 100),
      // Day 6: breaks low only
      etBar(6, 9, 30, 101, 99),
      etBar(6, 11, 0, 100, 95),
      // Day 7: breaks neither
      etBar(7, 9, 30, 101, 99),
      etBar(7, 11, 0, 100.5, 99.5),
      // Day 8: breaks both
      etBar(8, 9, 30, 101, 99),
      etBar(8, 11, 0, 105, 95),
    ];
    const stats = computeOpeningRangeStats(bars, "ES", RTH_OPEN_HOUR, RTH_OPEN_MINUTE);
    expect(stats.sessionsAnalyzed).toBe(4);
    expect(stats.probHighBroken).toBeCloseTo(2 / 4); // days 5 and 8
    expect(stats.probLowBroken).toBeCloseTo(2 / 4); // days 6 and 8
    expect(stats.probBothBroken).toBeCloseTo(1 / 4); // day 8
    expect(stats.probNeitherBroken).toBeCloseTo(1 / 4); // day 7
  });

  it("skips a session with no later-session bars (still forming/incomplete day)", () => {
    const bars: OhlcBar[] = [etBar(9, 9, 30, 101, 99), etBar(9, 9, 45, 100.5, 99.5)]; // only opening-range bars, no later bars yet
    const stats = computeOpeningRangeStats(bars, "ES", RTH_OPEN_HOUR, RTH_OPEN_MINUTE);
    expect(stats.sessionsAnalyzed).toBe(0);
    expect(stats.probHighBroken).toBeNull();
  });

  it("returns nulls with zero sessions when given no bars at all", () => {
    const stats = computeOpeningRangeStats([], "ES", RTH_OPEN_HOUR, RTH_OPEN_MINUTE);
    expect(stats.sessionsAnalyzed).toBe(0);
    expect(stats.probHighBroken).toBeNull();
    expect(stats.probLowBroken).toBeNull();
  });

  it("respects a different RTH open time (e.g. GC's 8:20am ET)", () => {
    const bars: OhlcBar[] = [
      etBar(5, 8, 20, 101, 99),
      etBar(5, 8, 50, 100.5, 99.5),
      etBar(5, 9, 30, 105, 100), // later session for an 8:20 open + 60min range starts at 9:20
    ];
    const stats = computeOpeningRangeStats(bars, "GC", 8, 20);
    expect(stats.sessionsAnalyzed).toBe(1);
    expect(stats.probHighBroken).toBe(1);
  });
});
