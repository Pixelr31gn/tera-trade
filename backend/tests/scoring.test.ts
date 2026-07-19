import { describe, expect, it } from "vitest";
import { evaluateSetup, shouldOverrideToTaken, type GatedScore } from "../src/scoring/gate.js";
import { scoreSetup } from "../src/scoring/ruleScorer.js";
import type { SetupFeatures } from "../src/scoring/features.js";

function fakeGated(decision: "taken" | "skipped_score", probability = 0.7): GatedScore {
  return { probability, decision, factors: [], modelUsed: "rule_v1", blockReason: null, v3Bucket: null };
}

function features(overrides: Partial<SetupFeatures> = {}): SetupFeatures {
  return {
    symbol: "ES",
    side: "long",
    momentum10: 0.01,
    atrNormalizedRange: 1.0,
    distanceFromMa20Atr: 0.5,
    volumeZscore: 1.0,
    realizedVolZscore: 0.0,
    trendLabel: "up",
    volLabel: "normal",
    regimeConfidence: 0.7,
    adx: 30.0,
    slopeR2: 0.6,
    hourOfDayUtc: 15,
    isRthSession: true,
    newsRiskFlag: false,
    newsMinutesToEvent: null,
    strategyHistoricalWinRate: null,
    openingRangeBreakoutProbability: null,
    openingRangeSampleSize: 0,
    session: "new_york",
    marketStructureLabel: "weak_uptrend",
    liquidityLabel: "normal",
    priceActionLabel: "normal",
    dailyTrendLabel: "none",
    dailyTrendConfidence: 0,
    // Generous defaults so existing tests aren't incidentally blocked by the
    // long-target-edge gate; tests exercising that gate specifically override these.
    longTargetWinRate: 0.9,
    longTargetSampleSize: 100,
    riskRewardRatio: null,
    fibSwingDirection: null,
    fibRetracementPct: null,
    netPointsPerMinute: null,
    orderFlowSnapshot: null,
    ...overrides,
  };
}

describe("scoreSetup", () => {
  it("scores an aligned-trend setup higher than a counter-trend one", () => {
    const aligned = scoreSetup(features({ trendLabel: "up", side: "long" }));
    const counter = scoreSetup(features({ trendLabel: "down", side: "long" }));
    expect(aligned.probability).toBeGreaterThan(counter.probability);
  });

  it("meaningfully lowers the score under news risk", () => {
    const calm = scoreSetup(features({ newsRiskFlag: false }));
    const risky = scoreSetup(features({ newsRiskFlag: true, newsMinutesToEvent: 5 }));
    expect(risky.probability).toBeLessThan(calm.probability);
  });

  it("scores a setup aligned with a confident daily trend higher than one fighting it", () => {
    const aligned = scoreSetup(features({ side: "long", dailyTrendLabel: "up", dailyTrendConfidence: 0.8 }));
    const counter = scoreSetup(features({ side: "long", dailyTrendLabel: "down", dailyTrendConfidence: 0.8 }));
    expect(aligned.probability).toBeGreaterThan(counter.probability);
  });

  it("v1 ignores marketStructureLabel/liquidityLabel entirely -- v2 and v1 agree when both labels are neutral-ish", () => {
    // weak_uptrend + normal liquidity are the defaults; v2 should differ once we change them.
    const v1 = scoreSetup(features({}), "v1");
    const v2Neutral = scoreSetup(features({}), "v2");
    expect(v2Neutral.probability).not.toBe(v1.probability); // v2 always adds its two factors' base contribution
  });

  it("v2 penalizes ranging market structure more than v1 does", () => {
    const v1Ranging = scoreSetup(features({ marketStructureLabel: "ranging" }), "v1");
    const v2Ranging = scoreSetup(features({ marketStructureLabel: "ranging" }), "v2");
    const v2Trending = scoreSetup(features({ marketStructureLabel: "strong_uptrend", side: "long" }), "v2");
    expect(v2Ranging.probability).toBeLessThan(v2Trending.probability);
    // v1 has no marketStructureEdge factor at all -- confirm it's absent from v1's factor list.
    expect(v1Ranging.factors.some((f) => f.name === "marketStructureEdge")).toBe(false);
    expect(v2Ranging.factors.some((f) => f.name === "marketStructureEdge")).toBe(true);
  });

  it("v2 rewards high liquidity over normal/low liquidity", () => {
    const high = scoreSetup(features({ liquidityLabel: "high" }), "v2");
    const normal = scoreSetup(features({ liquidityLabel: "normal" }), "v2");
    const low = scoreSetup(features({ liquidityLabel: "low" }), "v2");
    expect(high.probability).toBeGreaterThan(normal.probability);
    expect(high.probability).toBeGreaterThan(low.probability);
  });

  it("defaults to v1 when no version is passed", () => {
    const explicit = scoreSetup(features({}), "v1");
    const implicit = scoreSetup(features({}));
    expect(implicit.probability).toBe(explicit.probability);
    expect(implicit.factors.some((f) => f.name === "liquidityEdge")).toBe(false);
  });
});

describe("evaluateSetup (gate)", () => {
  it("blocks low-probability setups", async () => {
    const gated = await evaluateSetup(features({ trendLabel: "down", side: "long", newsRiskFlag: true, newsMinutesToEvent: 2, adx: 15 }));
    expect(gated.decision).toBe("skipped_score");
  });

  it("allows high-probability setups", async () => {
    const gated = await evaluateSetup(features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9 }));
    expect(gated.decision).toBe("taken");
    expect(gated.probability).toBeGreaterThanOrEqual(0.65);
  });

  it("blocks a setup that fights a confident daily trend even when everything else looks good", async () => {
    const gated = await evaluateSetup(
      features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9, dailyTrendLabel: "down", dailyTrendConfidence: 0.9 })
    );
    expect(gated.decision).toBe("skipped_score");
  });

  it("no longer applies a fixed-target-points hard gate to longs -- a low historical 20pt win rate doesn't block an otherwise-qualifying long", async () => {
    const gated = await evaluateSetup(
      features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9, longTargetWinRate: 0.16, longTargetSampleSize: 339 })
    );
    expect(gated.decision).toBe("taken");
    expect(gated.blockReason).toBeNull();
  });

  it("no longer blocks a long just because there aren't enough historical fixed-target samples yet", async () => {
    const gated = await evaluateSetup(
      features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9, longTargetWinRate: null, longTargetSampleSize: 3 })
    );
    expect(gated.decision).toBe("taken");
    expect(gated.blockReason).toBeNull();
  });

  it("passes the strategy version through to the rule scorer", async () => {
    const v1 = await evaluateSetup(features({ marketStructureLabel: "ranging" }), "v1");
    const v2 = await evaluateSetup(features({ marketStructureLabel: "ranging" }), "v2");
    expect(v1.probability).not.toBe(v2.probability);
  });
});

describe("evaluateSetup (gate) - v3", () => {
  it("throws if v3Inputs (bars) aren't provided", async () => {
    await expect(evaluateSetup(features({}), "v3")).rejects.toThrow(/v3Inputs is required/);
  });

  // evaluateSetup's v3 path also calls computeHistoricalAdjustment, which
  // hits the real DB -- deliberately not unit-tested end-to-end here, same
  // convention as engine/fixedTargetEdgeCache.ts / engine/openingRangeCache.ts:
  // the DB query wrapper isn't unit tested, only the pure logic feeding it.
  // See tests/ruleScorerV3.test.ts for scoreSetupV3Directional coverage and
  // computeAdjustmentFromOutcomes for the historical-adjustment math itself.
});

describe("shouldOverrideToTaken (v1/v2 -> v3 override)", () => {
  it("overrides when both v1 and v2 took the setup", () => {
    expect(shouldOverrideToTaken(fakeGated("taken"), fakeGated("taken"))).toBe(true);
  });

  it("does not override when only v1 took it", () => {
    expect(shouldOverrideToTaken(fakeGated("taken"), fakeGated("skipped_score"))).toBe(false);
  });

  it("does not override when only v2 took it", () => {
    expect(shouldOverrideToTaken(fakeGated("skipped_score"), fakeGated("taken"))).toBe(false);
  });

  it("does not override when neither took it", () => {
    expect(shouldOverrideToTaken(fakeGated("skipped_score"), fakeGated("skipped_score"))).toBe(false);
  });

  it("does not override when either version's result is missing", () => {
    expect(shouldOverrideToTaken(undefined, fakeGated("taken"))).toBe(false);
    expect(shouldOverrideToTaken(fakeGated("taken"), undefined)).toBe(false);
    expect(shouldOverrideToTaken(undefined, undefined)).toBe(false);
  });
});
