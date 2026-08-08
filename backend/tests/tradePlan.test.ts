import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeTradePlan } from "../src/risk/tradePlan.js";
import { MAX_STOP_DISTANCE_POINTS } from "../src/risk/stops.js";

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
      averageProbability: 0.85, // 85%+ tier -> 3 contracts (quantity is now confidence-tier-driven, not dollar-derived; default tiers moved 65/71/82% -> 65/75/85% 2026-08-02)
    });

    expect(plan.quantity).toBe(3);
    const actualRiskDollars = plan.stopDistancePoints.times(5).times(plan.quantity);
    // Floor is 130/3 = 43.33 -- actual risk must land at (approximately) that floor, not the few dollars the raw ATR stop would have given.
    expect(actualRiskDollars.toNumber()).toBeCloseTo(130 / 3, 1);
    expect(plan.sizingReason).toContain("stop widened");
  });

  it("does not touch the stop when the natural (capped) ATR-based risk already clears the floor", () => {
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(2), // 3pt stop at the default 1.5x multiplier -- under the 5pt max-stop cap, so uncapped
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: new Decimal(30), // floor = 10; natural risk (3pts * $5 * 1 contract = $15) comfortably clears it
      maxPositionSize: 3,
    });

    expect(plan.sizingReason).not.toContain("stop widened");
    expect(plan.stopDistancePoints.toNumber()).toBeCloseTo(3, 5);
  });

  it("does not widen past the 5pt max-stop cap even when the fixed-dollar floor would otherwise want a wider stop (2026-08-06)", () => {
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(6.667), // ~10pt natural ATR stop -- immediately capped to 5pt by stops.ts
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: new Decimal(120), // floor = 40; would need an 8pt stop to clear it, past the 5pt cap
      maxPositionSize: 3,
    });

    expect(plan.stopDistancePoints.toNumber()).toBeLessThanOrEqual(MAX_STOP_DISTANCE_POINTS.toNumber());
    expect(plan.sizingReason).not.toContain("stop widened");
    expect(plan.sizingReason).toContain("exceed the");
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

describe("computeTradePlan -- explicit stop/target override (strategy/trendPullbackFib.ts)", () => {
  it("uses the explicit stop/target exactly, ignoring the generic structure/ATR computation entirely", () => {
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(10), // would normally drive a ~15pt ATR stop (1.5x multiplier) -- irrelevant here
      structureSwingPrice: new Decimal(5990), // would normally compete against ATR -- irrelevant here
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: null,
      maxPositionSize: 3,
      averageProbability: 0.7,
      explicitStopPrice: new Decimal(5995), // 5pt stop -- tighter than either generic option
      explicitTakeProfitPrice: new Decimal(6015), // 15pt target -- exactly 3:1, but exceeds the 10pt max-target cap
    });

    expect(plan.stopPrice.toNumber()).toBe(5995);
    // 2026-08-06: 15pt explicit target clamped to the 10pt max-target cap.
    expect(plan.takeProfitPrice.toNumber()).toBe(6010);
    expect(plan.stopDistancePoints.toNumber()).toBe(5);
  });

  it("sizes off the explicit stop distance, not the generic one", () => {
    // Quantity is confidence-tier-driven (0.75 -> 2 contracts, see
    // risk/sizing.ts's DEFAULT_CONFIDENCE_TIERS), not dollar-derived -- what
    // this test actually isolates is the RISK DOLLAR figure computed from
    // that quantity, which only comes out to $50 (5pt explicit stop x $5
    // pointValue x 2 contracts) if sizing used the explicit stop distance.
    // The generic ATR stop here (~15pt) would have given $150 instead.
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(10),
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: null,
      maxPositionSize: 10,
      averageProbability: 0.75,
      explicitStopPrice: new Decimal(5995), // 5pt stop
      explicitTakeProfitPrice: new Decimal(6015),
    });

    expect(plan.sizingReason).toContain("2 contract(s) (actual risk $50.00)");
  });

  it("mirrors for a short -- explicit stop above entry, target below", () => {
    const plan = computeTradePlan({
      side: "short",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(10),
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: null,
      maxPositionSize: 3,
      averageProbability: 0.7,
      explicitStopPrice: new Decimal(6005),
      explicitTakeProfitPrice: new Decimal(5985), // 15pt target -- exceeds the 10pt max-target cap
    });

    expect(plan.stopPrice.toNumber()).toBe(6005);
    // 2026-08-06: 15pt explicit target clamped to the 10pt max-target cap.
    expect(plan.takeProfitPrice.toNumber()).toBe(5990);
    expect(plan.stopDistancePoints.toNumber()).toBe(5);
  });

  it("an explicit target takes priority over a configured fixed-dollar profit target", () => {
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(10),
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: new Decimal(500), // would normally drive its own target price
      maxPositionSize: 3,
      averageProbability: 0.7,
      explicitStopPrice: new Decimal(5995),
      explicitTakeProfitPrice: new Decimal(6015), // should win over the $500 target, then get capped at 10pt
    });

    // 2026-08-06: 15pt explicit target clamped to the 10pt max-target cap.
    expect(plan.takeProfitPrice.toNumber()).toBe(6010);
    expect(plan.sizingReason).not.toContain("stop widened"); // the fixed-dollar floor logic never ran
  });

  it("falls back to the generic stop/target when neither explicit price is provided, capped at the 5pt max-stop (2026-08-06)", () => {
    const withoutOverride = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(10),
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: null,
      maxPositionSize: 3,
      averageProbability: 0.7,
    });

    // 1.5x ATR default stop multiplier would naturally give 15pt here (see
    // risk/stops.ts's computeInitialStop), but the 5pt max-stop cap (2026-08-06,
    // operator request) clamps it down.
    expect(withoutOverride.stopDistancePoints.toNumber()).toBeCloseTo(5, 5);
  });
});
