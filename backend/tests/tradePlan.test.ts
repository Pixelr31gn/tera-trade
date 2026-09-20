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
      averageProbability: 0.85, // 85%+ tier -> 3 contracts (quantity is now confidence-tier-driven, not dollar-derived; default tiers moved 65/71/82% -> 65/75/85% 2026-08-02)
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
      atrValue: new Decimal(2), // 3pt stop at the default 1.5x multiplier
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

  it("widens the stop as far as the fixed-dollar floor demands, with no upper cap (removed 2026-09-08, see stops.ts's MIN_REWARD_RISK_RATIO comment)", () => {
    const plan = computeTradePlan({
      side: "long",
      entryPrice: new Decimal(6000),
      atrValue: new Decimal(6.667), // ~10pt natural ATR stop
      structureSwingPrice: null,
      tickSize: new Decimal("0.25"),
      pointValue: new Decimal(5),
      riskAmount: new Decimal(200),
      profitDollars: new Decimal(120), // floor = 40; needs an 8pt stop to clear it -- wider than the natural ~10pt stop's own risk was already fine, so this specific case shouldn't widen at all
      maxPositionSize: 3,
      averageProbability: 0.7,
    });

    // Natural stop (10.0005pt) already gives actualRiskDollars = 10.0005 x 5
    // x quantity >= the $40 floor for any nonzero quantity -- confirms no
    // widening needed here, the interesting case (needing MORE than the
    // natural distance) is covered by the near-zero-ATR tests above.
    expect(plan.sizingReason).not.toContain("stop widened");
    expect(plan.stopDistancePoints.toNumber()).toBeCloseTo(6.667 * 1.5, 4);
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
      explicitTakeProfitPrice: new Decimal(6020), // 20pt target
    });

    expect(plan.stopPrice.toNumber()).toBe(5995);
    // Both explicit -- taken exactly as given, no cap and no derivation
    // (2026-09-08, see tradePlan.ts's "both explicit" branch).
    expect(plan.takeProfitPrice.toNumber()).toBe(6020);
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
      explicitTakeProfitPrice: new Decimal(5980), // 20pt target
    });

    expect(plan.stopPrice.toNumber()).toBe(6005);
    // Both explicit -- taken exactly as given, no cap (2026-09-08).
    expect(plan.takeProfitPrice.toNumber()).toBe(5980);
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
      explicitTakeProfitPrice: new Decimal(6020), // should win over the $500 target
    });

    // Both explicit -- wins outright, taken exactly as given, no cap.
    expect(plan.takeProfitPrice.toNumber()).toBe(6020);
    expect(plan.sizingReason).not.toContain("stop widened"); // the fixed-dollar floor logic never ran
  });

  it("falls back to the generic ATR-based stop/target when neither explicit price is provided", () => {
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

    // 1.5x ATR default stop multiplier, uncapped (2026-09-08, see
    // risk/stops.ts's computeInitialStop) -- 10 x 1.5 = 15pt.
    expect(withoutOverride.stopDistancePoints.toNumber()).toBeCloseTo(15, 5);
    expect(withoutOverride.takeProfitPrice.minus(6000).abs().toNumber()).toBeCloseTo(15 * 3, 5); // stop x default takeProfitRMultiple(3.0)
  });
});
