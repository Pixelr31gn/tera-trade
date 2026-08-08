import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeTradePlan } from "../src/risk/tradePlan.js";

describe("computeTradePlan -- minimum risk:reward floor", () => {
  it("widens the stop when a near-zero ATR would otherwise risk far less than 1/3 of the target", () => {
    // Mirrors the real bug: ATR computed from effectively zero-range price
    // ticks (0.05 pts) against a $130 fixed profit target and $65 risk
    // budget on MES (pointValue $5) -- the natural ATR-based stop is tiny,
    // sizing wants far more than maxPositionSize contracts, gets capped at
    // 3, and actual risk ends up a few dollars against a $130 target.
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(0.05),
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(65),
      profitDollars: new Decimal(130),
      maxPositionSize: 3,
      averageProbability: 0.82, // 82%+ tier -> 3 contracts (quantity is now confidence-tier-driven, not dollar-derived)
    });

    expect(plan.quantity).toBe(3);
    const actualRiskDollars = plan.stopDistancePoints.times(5).times(plan.quantity);
    // Floor is 130/3 = 43.33 -- actual risk must land at (approximately) that floor, not the few dollars the raw ATR stop would have given.
    expect(actualRiskDollars.toNumber()).toBeCloseTo(130 / 3, 1);
    expect(plan.sizingReason).toContain("stop widened");
  });

  it("does not touch the stop when the natural ATR-based risk already clears the floor", () => {
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(6.667), // ~10pt stop at the default 1.5x multiplier
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: new Decimal(120), // floor = 40; natural risk (10pts * $5 * qty) comfortably clears it
      maxPositionSize: 3,
    });

    expect(plan.sizingReason).not.toContain("stop widened");
  });

  it("mirrors the widening below entry for a short (stop moves further above)", () => {
    const entryPrice = new Decimal(6000);
    const plan = computeTradePlan({
      side: "short",
      entryPrice,
      atrValue: new Decimal(0.05),
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(65),
      profitDollars: new Decimal(130),
      maxPositionSize: 3,
    });

    expect(plan.stopPrice.greaterThan(entryPrice)).toBe(true);
  });

  it("does not apply the floor when no fixed profit target is configured (R:R fallback is already 2:1)", () => {
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(0.05),
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(65),
      profitDollars: null,
      maxPositionSize: 3,
    });

    expect(plan.sizingReason).not.toContain("stop widened");
  });
});
