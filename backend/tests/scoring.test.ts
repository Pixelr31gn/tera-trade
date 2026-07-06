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
});
