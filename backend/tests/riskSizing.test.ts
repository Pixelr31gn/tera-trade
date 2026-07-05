import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computePositionSize } from "../src/risk/sizing.js";

describe("computePositionSize", () => {
  it("scales with risk and stop distance", () => {
    const result = computePositionSize(new Decimal(50000), new Decimal(1), new Decimal(4), new Decimal(50), 10);
    expect(result.quantity).toBe(2); // risk=$500, risk/contract=$200 -> 2
    expect(result.cappedByMaxPosition).toBe(false);
  });

  it("caps at the max position size", () => {
    const result = computePositionSize(new Decimal(50000), new Decimal(5), new Decimal(1), new Decimal(50), 3);
    expect(result.quantity).toBe(3);
    expect(result.cappedByMaxPosition).toBe(true);
  });

  it("sizes to zero with no stop distance", () => {
    const result = computePositionSize(new Decimal(50000), new Decimal(1), new Decimal(0), new Decimal(50), 10);
    expect(result.quantity).toBe(0);
    expect(result.reason).toContain("no stop distance");
  });

  it("sizes to zero when the stop is too wide for the account", () => {
    const result = computePositionSize(new Decimal(1000), new Decimal(0.5), new Decimal(100), new Decimal(50), 10);
    expect(result.quantity).toBe(0);
  });
});
