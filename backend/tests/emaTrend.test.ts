import { describe, expect, it } from "vitest";
import { computeEma20Ema200Regime, ema } from "../src/analytics/emaTrend.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function makeBars(closes: number[]): OhlcBar[] {
  return closes.map((close, i) => ({
    time: new Date(2026, 0, 1, 0, i * 5),
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  }));
}

describe("computeEma20Ema200Regime", () => {
  it("returns null when there aren't enough bars for a 200-period EMA", () => {
    const bars = makeBars(new Array(199).fill(100));
    expect(computeEma20Ema200Regime(bars)).toBeNull();
  });

  it("returns bullish once the fast EMA is clearly above the slow EMA", () => {
    // 200 bars flat at 100, then a strong run-up -- 20 EMA reacts much
    // faster than 200 EMA and pulls above it.
    const flat = new Array(200).fill(100);
    const rampUp = Array.from({ length: 40 }, (_, i) => 100 + (i + 1) * 5);
    const bars = makeBars([...flat, ...rampUp]);
    expect(computeEma20Ema200Regime(bars)).toBe("bullish");
  });

  it("returns bearish once the fast EMA is clearly below the slow EMA", () => {
    const flat = new Array(200).fill(100);
    const rampDown = Array.from({ length: 40 }, (_, i) => 100 - (i + 1) * 5);
    const bars = makeBars([...flat, ...rampDown]);
    expect(computeEma20Ema200Regime(bars)).toBe("bearish");
  });

  it("matches a direct fast/slow ema() comparison on the same series", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.05);
    const bars = makeBars(closes);
    const fast = ema(closes, 20).at(-1)!;
    const slow = ema(closes, 200).at(-1)!;
    expect(computeEma20Ema200Regime(bars)).toBe(fast > slow ? "bullish" : "bearish");
  });
});
