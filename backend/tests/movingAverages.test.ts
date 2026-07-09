import { describe, expect, it } from "vitest";
import { classifyMaStack, sma } from "../src/analytics/movingAverages.js";

describe("sma", () => {
  it("computes a simple moving average once enough values have accumulated", () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
    expect(result[2]).toBeCloseTo(2); // (1+2+3)/3
    expect(result[3]).toBeCloseTo(3); // (2+3+4)/3
    expect(result[4]).toBeCloseTo(4); // (3+4+5)/3
  });
});

describe("classifyMaStack", () => {
  it("reads 'up' when price and MAs are fully stacked ascending", () => {
    // Strong steady uptrend: enough bars for all three periods, each MA below the last.
    const closes = Array.from({ length: 210 }, (_, i) => 100 + i * 0.5);
    const stack = classifyMaStack(closes);
    expect(stack.direction).toBe("up");
    expect(stack.maFast).toBeGreaterThan(stack.maMid!);
    expect(stack.maMid).toBeGreaterThan(stack.maSlow!);
  });

  it("reads 'down' when price and MAs are fully stacked descending", () => {
    const closes = Array.from({ length: 210 }, (_, i) => 300 - i * 0.5);
    const stack = classifyMaStack(closes);
    expect(stack.direction).toBe("down");
  });

  it("reads 'mixed' when there aren't enough bars for the slow MA yet", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    const stack = classifyMaStack(closes);
    expect(stack.maSlow).toBeNull();
    expect(stack.direction).toBe("mixed");
  });

  it("reads 'mixed' for a choppy/ranging series with no clean stack order", () => {
    const closes = Array.from({ length: 210 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const stack = classifyMaStack(closes);
    expect(stack.direction).toBe("mixed");
  });
});
