import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeRangePlan, MIN_LIKELY_MOVE_ATR5 } from "../src/assistant/rangePlan.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const NOW = Date.parse("2026-10-12T23:00:00Z");
const TICK = new Decimal("0.25");

/** 600 one-minute bars ending at NOW, swinging between `low` and `high`, closing at `last`. */
function bars(low: number, high: number, last: number, wiggle = 2): OhlcBar[] {
  const n = 600;
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(NOW - (n - 1 - i) * 60_000);
    const mid = i === n - 1 ? last : low + ((high - low) * (Math.sin(i / 40) + 1)) / 2;
    return { time: t, open: mid, high: Math.min(high, mid + wiggle), low: Math.max(low, mid - wiggle), close: mid, volume: 100 };
  });
}

describe("computeRangePlan", () => {
  it("puts support at the 24h low and resistance at the 24h high, separate and bracketing price", () => {
    const plan = computeRangePlan(bars(31000, 31200, 31100), TICK, NOW);
    if ("error" in plan) throw new Error(plan.error);
    const [support, resistance] = plan.zones;
    expect(plan.low).toBe(31000);
    expect(plan.high).toBe(31200);
    expect(support.priceLow).toBeLessThan(31000);
    expect(support.priceHigh).toBeGreaterThan(31000);
    expect(resistance.priceLow).toBeLessThan(31200);
    expect(resistance.priceHigh).toBeGreaterThan(31200);
    expect(support.priceHigh).toBeLessThan(resistance.priceLow);
    expect(support.priceLow).toBeLessThan(plan.price);
    expect(resistance.priceHigh).toBeGreaterThan(plan.price);
  });

  it("keeps the likely move at least MIN_LIKELY_MOVE_ATR5 x the 5-minute ATR so trades aren't starved", () => {
    const plan = computeRangePlan(bars(31000, 31200, 31100), TICK, NOW);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.likelyMovePoints).toBeGreaterThanOrEqual(Math.min(200, MIN_LIKELY_MOVE_ATR5 * plan.atr5) - 0.01);
    expect(plan.likelyMovePoints).toBeGreaterThanOrEqual(MIN_LIKELY_MOVE_ATR5 * plan.atr5 - 0.01);
  });

  it("ignores junk readings like 0 or 375 when finding the range", () => {
    const b = bars(4180, 4220, 4200);
    b[100] = { ...b[100]!, low: 375, close: 375, open: 375 };
    b[200] = { ...b[200]!, low: 0, high: 0, close: 0, open: 0 };
    const plan = computeRangePlan(b, new Decimal("0.1"), NOW);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.low).toBeGreaterThan(4000);
  });

  it("refuses a range too narrow for two separate zones", () => {
    const plan = computeRangePlan(bars(31100, 31101, 31100.5, 0.5), TICK, NOW);
    expect("error" in plan).toBe(true);
  });

  it("refuses when there aren't enough bars", () => {
    expect("error" in computeRangePlan(bars(1, 2, 1.5).slice(-10), TICK, NOW)).toBe(true);
  });
});
