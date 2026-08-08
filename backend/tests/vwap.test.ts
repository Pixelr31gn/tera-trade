import { describe, expect, it } from "vitest";
import { computeRollingVwap, computeSessionVwap } from "../src/analytics/vwap.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function bar(time: string, price: number, volume: number): OhlcBar {
  return { time: new Date(time), open: price, high: price + 1, low: price - 1, close: price, volume };
}

describe("computeSessionVwap", () => {
  it("returns null with no bars", () => {
    expect(computeSessionVwap([])).toBeNull();
  });

  it("only includes bars from the same UTC calendar day as the last bar", () => {
    const bars = [
      bar("2026-01-01T23:00:00Z", 100, 10), // previous day -- excluded
      bar("2026-01-02T00:00:00Z", 200, 10),
      bar("2026-01-02T01:00:00Z", 200, 10),
    ];
    const vwap = computeSessionVwap(bars);
    // If the prior-day bar leaked in, the average would pull toward 100.
    expect(vwap).toBeCloseTo(200, 5);
  });

  it("weights by volume, not a plain average", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 100, 90), bar("2026-01-01T00:01:00Z", 200, 10)];
    const vwap = computeSessionVwap(bars)!;
    expect(vwap).toBeLessThan(150); // heavier volume at 100 should pull it below the midpoint
  });
});

describe("computeRollingVwap", () => {
  it("returns null when there are fewer bars than the lookback", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 100, 10)];
    expect(computeRollingVwap(bars, 5)).toBeNull();
  });

  it("only considers the trailing N bars, unlike the session version", () => {
    const bars = [
      bar("2026-01-01T00:00:00Z", 1000, 100), // way outside the lookback window
      bar("2026-01-01T00:01:00Z", 200, 10),
      bar("2026-01-01T00:02:00Z", 200, 10),
    ];
    const vwap = computeRollingVwap(bars, 2)!;
    expect(vwap).toBeCloseTo(200, 5);
  });

  it("weights by volume within the window", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 100, 90), bar("2026-01-01T00:01:00Z", 200, 10)];
    const vwap = computeRollingVwap(bars, 2)!;
    expect(vwap).toBeLessThan(150);
  });
});
