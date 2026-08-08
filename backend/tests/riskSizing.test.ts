import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeConfidenceTierQuantity, computePositionSize } from "../src/risk/sizing.js";

describe("computePositionSize", () => {
  it("scales with risk and stop distance", () => {
    const result = computePositionSize(new Decimal(500), new Decimal(4), new Decimal(50), 10);
    expect(result.quantity).toBe(2); // risk=$500, risk/contract=$200 -> 2
    expect(result.cappedByMaxPosition).toBe(false);
  });

  it("caps at the max position size", () => {
    const result = computePositionSize(new Decimal(2500), new Decimal(1), new Decimal(50), 3);
    expect(result.quantity).toBe(3);
    expect(result.cappedByMaxPosition).toBe(true);
  });

  it("sizes to zero with no stop distance", () => {
    const result = computePositionSize(new Decimal(500), new Decimal(0), new Decimal(50), 10);
    expect(result.quantity).toBe(0);
    expect(result.reason).toContain("no stop distance");
  });

  it("still sizes to 1 contract (never 0) when the risk budget doesn't fully cover the stop distance", () => {
    // $5 budget, 100pt stop, $50/point -> $5000/contract risk, far above the
    // nominal budget -- must still take 1 contract rather than skip a valid,
    // structure-validated setup entirely.
    const result = computePositionSize(new Decimal(5), new Decimal(100), new Decimal(50), 10);
    expect(result.quantity).toBe(1);
    expect(result.reason).toContain("doesn't fully cover");
  });

  it("sizes correctly for a fixed-dollar risk budget (e.g. $50 risk per trade)", () => {
    // $50 risk, 10-point stop, $2/point (MNQ) -> risk/contract = $20 -> 2 contracts
    const result = computePositionSize(new Decimal(50), new Decimal(10), new Decimal(2), 10);
    expect(result.quantity).toBe(2);
  });
});

describe("computeConfidenceTierQuantity", () => {
  it("sizes to 1 contract at the 65% floor", () => {
    expect(computeConfidenceTierQuantity(0.65, 10)).toBe(1);
    expect(computeConfidenceTierQuantity(0.70, 10)).toBe(1);
  });

  it("sizes to 2 contracts at the 71% tier", () => {
    expect(computeConfidenceTierQuantity(0.71, 10)).toBe(2);
    expect(computeConfidenceTierQuantity(0.81, 10)).toBe(2);
  });

  it("sizes to 3 contracts at the 82% tier", () => {
    expect(computeConfidenceTierQuantity(0.82, 10)).toBe(3);
    expect(computeConfidenceTierQuantity(0.99, 10)).toBe(3);
  });

  it("never sizes below 1 contract even when average probability is below 65%", () => {
    // A signal can still reach execution with an average below 65% (e.g. two
    // versions just over the threshold and a third near 0%, since consensus
    // only requires 2/3 to individually clear it) -- a trade that already
    // cleared every other gate is never sized to zero for landing here.
    expect(computeConfidenceTierQuantity(0.5, 10)).toBe(1);
    expect(computeConfidenceTierQuantity(0, 10)).toBe(1);
  });

  it("respects maxPositionSize even at the highest confidence tier", () => {
    expect(computeConfidenceTierQuantity(0.95, 2)).toBe(2);
  });
});
