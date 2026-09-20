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
  // Default tiers moved 65/71/82% -> 65/75/85% (2026-08-02, operator
  // request) -- now operator-adjustable at runtime (see execution/mode.ts's
  // setConfidenceTiers); these tests exercise the DEFAULT_CONFIDENCE_TIERS
  // fallback specifically (no tiers arg passed), the real system always
  // passes the current SystemState tiers explicitly.
  it("sizes to 1 contract at the 65% floor", () => {
    expect(computeConfidenceTierQuantity(0.65, 10)).toBe(1);
    expect(computeConfidenceTierQuantity(0.70, 10)).toBe(1);
  });

  it("sizes to 2 contracts at the 75% tier", () => {
    expect(computeConfidenceTierQuantity(0.75, 10)).toBe(2);
    expect(computeConfidenceTierQuantity(0.84, 10)).toBe(2);
  });

  it("sizes to 3 contracts at the 85% tier", () => {
    expect(computeConfidenceTierQuantity(0.85, 10)).toBe(3);
    expect(computeConfidenceTierQuantity(0.99, 10)).toBe(3);
  });

  it("accepts a custom tiers array, overriding the default", () => {
    const customTiers: [number, number][] = [[0.6, 1], [0.7, 2], [0.9, 5]];
    expect(computeConfidenceTierQuantity(0.65, 10, customTiers)).toBe(1);
    expect(computeConfidenceTierQuantity(0.75, 10, customTiers)).toBe(2);
    expect(computeConfidenceTierQuantity(0.95, 10, customTiers)).toBe(5);
  });

  it("never sizes below the lowest tier's quantity when average probability lands below every tier", () => {
    // A signal can still reach execution with an average below the lowest
    // tier (e.g. two versions just over the threshold and a third near 0%,
    // or a v7-solo execution, since consensus doesn't require the AVERAGE
    // to clear any tier -- see engine/loop.ts's determineConsensus) -- a
    // trade that already cleared every other gate is never sized to zero
    // for landing here. With the default tiers, the lowest tier's quantity
    // happens to be 1 (65% -> 1 contract), so this doesn't distinguish "floor
    // = lowest tier's quantity" from "floor = hardcoded 1" -- see the
    // dedicated test below with a custom tiers array where the lowest
    // tier's quantity is NOT 1 for that.
    expect(computeConfidenceTierQuantity(0.5, 10)).toBe(1);
    expect(computeConfidenceTierQuantity(0, 10)).toBe(1);
  });

  it("floors to the LOWEST configured tier's own quantity, not a hardcoded 1, when average lands below every tier", () => {
    // 2026-08-11 regression: matches a real live SystemState config (29%/2,
    // 76%/3, 85%/4) where the lowest tier's quantity is 2, not 1 -- quantity
    // must still trace back to the operator's own certainty-tier
    // configuration in the below-every-tier gap, not an unrelated constant.
    const liveTiers: [number, number][] = [[0.29, 2], [0.76, 3], [0.85, 4]];
    expect(computeConfidenceTierQuantity(0.2, 10, liveTiers)).toBe(2);
    expect(computeConfidenceTierQuantity(0, 10, liveTiers)).toBe(2);
    expect(computeConfidenceTierQuantity(0.29, 10, liveTiers)).toBe(2); // inclusive at the tier's own threshold
    expect(computeConfidenceTierQuantity(0.76, 10, liveTiers)).toBe(3);
    expect(computeConfidenceTierQuantity(0.85, 10, liveTiers)).toBe(4);
  });

  it("respects maxPositionSize even at the highest confidence tier", () => {
    expect(computeConfidenceTierQuantity(0.95, 2)).toBe(2);
  });

  it("respects maxPositionSize even at the below-every-tier floor", () => {
    const liveTiers: [number, number][] = [[0.29, 2], [0.76, 3], [0.85, 4]];
    expect(computeConfidenceTierQuantity(0.1, 1, liveTiers)).toBe(1);
  });
});
