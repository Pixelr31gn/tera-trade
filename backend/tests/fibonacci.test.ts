import { describe, expect, it } from "vitest";
import { computeFibLevels, findSwing } from "../src/analytics/fibonacci.js";

describe("computeFibLevels", () => {
  it("computes retracement levels for an up-swing, 0% at the high and 100% at the low", () => {
    const levels = computeFibLevels(110, 100, "up");
    const byLabel = Object.fromEntries(levels.map((l) => [l.label, l.price]));
    expect(byLabel["0.0%"]).toBeCloseTo(110);
    expect(byLabel["100.0%"]).toBeCloseTo(100);
    expect(byLabel["50.0%"]).toBeCloseTo(105);
    expect(byLabel["61.8%"]).toBeCloseTo(110 - 10 * 0.618);
  });

  it("computes extension levels above the high for an up-swing", () => {
    const levels = computeFibLevels(110, 100, "up");
    const ext1618 = levels.find((l) => l.label === "161.8% ext");
    expect(ext1618?.price).toBeCloseTo(110 + 10 * 0.618);
  });

  it("computes retracement levels for a down-swing, 0% at the low and 100% at the high", () => {
    const levels = computeFibLevels(110, 100, "down");
    const byLabel = Object.fromEntries(levels.map((l) => [l.label, l.price]));
    expect(byLabel["0.0%"]).toBeCloseTo(100);
    expect(byLabel["100.0%"]).toBeCloseTo(110);
  });

  it("computes extension levels below the low for a down-swing", () => {
    const levels = computeFibLevels(110, 100, "down");
    const ext1618 = levels.find((l) => l.label === "161.8% ext");
    expect(ext1618?.price).toBeCloseTo(100 - 10 * 0.618);
  });

  it("returns an empty list when the range is zero or negative", () => {
    expect(computeFibLevels(100, 100, "up")).toEqual([]);
    expect(computeFibLevels(90, 100, "up")).toEqual([]);
  });

  it("returns levels sorted ascending by price", () => {
    const levels = computeFibLevels(110, 100, "up");
    const prices = levels.map((l) => l.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });
});

describe("findSwing", () => {
  it("reads an up-swing when the low occurs before the high", () => {
    const bars = [{ high: 102, low: 100 }, { high: 105, low: 103 }, { high: 110, low: 106 }];
    const swing = findSwing(bars);
    expect(swing).toEqual({ high: 110, low: 100, direction: "up" });
  });

  it("reads a down-swing when the high occurs before the low", () => {
    const bars = [{ high: 110, low: 106 }, { high: 105, low: 103 }, { high: 102, low: 96 }];
    const swing = findSwing(bars);
    expect(swing).toEqual({ high: 110, low: 96, direction: "down" });
  });

  it("returns null for an empty bar list", () => {
    expect(findSwing([])).toBeNull();
  });
});
