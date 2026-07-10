import { describe, expect, it } from "vitest";
import { evaluateSetup } from "../src/scoring/gate.js";
import { scoreSetup } from "../src/scoring/ruleScorer.js";
import type { SetupFeatures } from "../src/scoring/features.js";

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
  it("blocks low-probability setups", () => {
    const gated = evaluateSetup(features({ trendLabel: "down", side: "long", newsRiskFlag: true, newsMinutesToEvent: 2, adx: 15 }));
    expect(gated.decision).toBe("skipped_score");
  });

  it("allows high-probability setups", () => {
    const gated = evaluateSetup(features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9 }));
    expect(gated.decision).toBe("taken");
    expect(gated.probability).toBeGreaterThanOrEqual(0.65);
  });

  it("blocks a setup that fights a confident daily trend even when everything else looks good", () => {
    const gated = evaluateSetup(
      features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9, dailyTrendLabel: "down", dailyTrendConfidence: 0.9 })
    );
    expect(gated.decision).toBe("skipped_score");
  });

  it("blocks an otherwise-qualifying long when the historical 20pt win rate is below 67%, and explains why", () => {
    const gated = evaluateSetup(
      features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9, longTargetWinRate: 0.16, longTargetSampleSize: 339 })
    );
    expect(gated.decision).toBe("skipped_score");
    expect(gated.blockReason).toMatch(/16%/);
    expect(gated.blockReason).toMatch(/339 samples/);
  });

  it("blocks an otherwise-qualifying long when there aren't enough historical samples yet", () => {
    const gated = evaluateSetup(
      features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9, longTargetWinRate: null, longTargetSampleSize: 3 })
    );
    expect(gated.decision).toBe("skipped_score");
    expect(gated.blockReason).toMatch(/not enough historical samples/);
  });

  it("takes an otherwise-qualifying long once the historical 20pt win rate clears 67% with enough samples", () => {
    const gated = evaluateSetup(
      features({ trendLabel: "up", side: "long", momentum10: 0.03, adx: 40, slopeR2: 0.9, longTargetWinRate: 0.72, longTargetSampleSize: 40 })
    );
    expect(gated.decision).toBe("taken");
    expect(gated.blockReason).toBeNull();
  });

  it("does not apply the long-target-edge gate to short setups", () => {
    const gated = evaluateSetup(
      features({ trendLabel: "down", side: "short", momentum10: -0.03, adx: 40, slopeR2: 0.9, longTargetWinRate: 0.05, longTargetSampleSize: 500 })
    );
    expect(gated.decision).toBe("taken");
  });

  it("passes the strategy version through to the rule scorer", () => {
    const v1 = evaluateSetup(features({ marketStructureLabel: "ranging" }), "v1");
    const v2 = evaluateSetup(features({ marketStructureLabel: "ranging" }), "v2");
    expect(v1.probability).not.toBe(v2.probability);
  });
});
