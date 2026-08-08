import { describe, expect, it } from "vitest";
import { aggregateBars, intraday5mEmaDistanceAtr } from "../src/analytics/intradayEmaProximity.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function oneMinBars(count: number, startPrice: number, pointsPerBar: number, startAt = new Date("2026-01-01T00:00:00Z").getTime()): OhlcBar[] {
  const bars: OhlcBar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += pointsPerBar;
    const close = price;
    bars.push({
      time: new Date(startAt + i * 60_000),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 100,
    });
  }
  return bars;
}

describe("aggregateBars", () => {
  it("groups 1-minute bars into 5-minute wall-clock-aligned buckets", () => {
    const bars = oneMinBars(10, 100, 1); // 10 one-minute bars starting at :00 -> two clean 5-minute buckets
    const fiveMin = aggregateBars(bars, 5);
    expect(fiveMin.length).toBe(2);
    expect(fiveMin[0]!.open).toBe(bars[0]!.open);
    expect(fiveMin[0]!.close).toBe(bars[4]!.close);
    expect(fiveMin[0]!.high).toBe(Math.max(...bars.slice(0, 5).map((b) => b.high)));
    expect(fiveMin[0]!.low).toBe(Math.min(...bars.slice(0, 5).map((b) => b.low)));
    expect(fiveMin[0]!.volume).toBe(500);
    expect(fiveMin[1]!.close).toBe(bars[9]!.close);
  });

  it("keeps bucket boundaries aligned to wall-clock time even when the source data has a gap", () => {
    // Bars at :00 and :01 (bucket 0), then a gap, then a bar at :07 (bucket 1, :05-:10) --
    // the gap must not shift bucket 1's boundary to start right after the last seen bar.
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const bars: OhlcBar[] = [
      { time: new Date(base), open: 100, high: 101, low: 100, close: 100.5, volume: 10 },
      { time: new Date(base + 60_000), open: 100.5, high: 101, low: 100, close: 100.8, volume: 10 },
      { time: new Date(base + 7 * 60_000), open: 105, high: 106, low: 104, close: 105.5, volume: 10 },
    ];
    const fiveMin = aggregateBars(bars, 5);
    expect(fiveMin.length).toBe(2);
    expect(fiveMin[0]!.time.getTime()).toBe(base);
    expect(fiveMin[1]!.time.getTime()).toBe(base + 5 * 60_000);
  });

  it("returns an empty array for no input", () => {
    expect(aggregateBars([], 5)).toEqual([]);
  });
});

describe("intraday5mEmaDistanceAtr", () => {
  it("returns null when there's no valid ATR", () => {
    const bars = oneMinBars(200, 100, 0.1);
    expect(intraday5mEmaDistanceAtr(bars, null)).toBeNull();
    expect(intraday5mEmaDistanceAtr(bars, 0)).toBeNull();
  });

  it("returns null when there aren't enough 5-minute bars for a 20-period EMA yet", () => {
    const bars = oneMinBars(50, 100, 0.1); // 50 one-min bars -> only 10 five-min bars, need 20
    expect(intraday5mEmaDistanceAtr(bars, 1.0)).toBeNull();
  });

  it("returns a positive distance when price has been steadily rising above its own recent average", () => {
    // 150 one-minute bars (30 five-minute bars) drifting steadily upward -- the
    // most recent close should sit above the EMA(20) of the rising series.
    const bars = oneMinBars(150, 100, 0.05);
    const distance = intraday5mEmaDistanceAtr(bars, 1.0);
    expect(distance).not.toBeNull();
    expect(distance!).toBeGreaterThan(0);
  });

  it("returns a negative distance when price has been steadily falling below its own recent average", () => {
    const bars = oneMinBars(150, 200, -0.05);
    const distance = intraday5mEmaDistanceAtr(bars, 1.0);
    expect(distance).not.toBeNull();
    expect(distance!).toBeLessThan(0);
  });

  it("returns near-zero distance for a flat, unchanging price series", () => {
    const bars = oneMinBars(150, 100, 0);
    const distance = intraday5mEmaDistanceAtr(bars, 1.0);
    expect(distance).toBeCloseTo(0, 5);
  });
});
