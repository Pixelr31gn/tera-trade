import { describe, expect, it } from "vitest";
import { scoreSetupV7, scoreMaDistanceAsymmetry, scoreAdxRegimeAsymmetry, scoreMomentumGrind } from "../src/scoring/ruleScorerV7.js";
import { evaluateSetup } from "../src/scoring/gate.js";
import type { SetupFeatures } from "../src/scoring/features.js";

// evaluateSetup requires an explicit `at` (see v3HistoricalAdjustment.ts) --
// the v7 dispatch path never reads it, so any fixed timestamp works.
const AT = new Date("2026-01-15T15:00:00Z");

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
    marketStructureLabel: "ranging",
    liquidityLabel: "normal",
    priceActionLabel: "normal",
    dailyTrendLabel: "none",
    dailyTrendConfidence: 0,
    longTargetWinRate: 0.9,
    longTargetSampleSize: 100,
    riskRewardRatio: null,
    fibSwingDirection: null,
    fibRetracementPct: null,
    netPointsPerMinute: null,
    orderFlowSnapshot: null,
    dailyEma20Trend: { ema: null, slope: null, label: "neutral" },
    intraday5mEmaDistanceAtr: null,
    ...overrides,
  };
}

describe("scoreMaDistanceAsymmetry", () => {
  it("scores a short moderately above the MA (best short bucket) higher than a short far below it (worst short bucket)", () => {
    const above = scoreMaDistanceAsymmetry(0.5, "short");
    const farBelow = scoreMaDistanceAsymmetry(-2, "short");
    expect(above.points).toBeGreaterThan(farBelow.points);
  });

  it("scores a long far below the MA (best long bucket) higher than a long moderately above it (worst long bucket)", () => {
    const farBelow = scoreMaDistanceAsymmetry(-2, "long");
    const above = scoreMaDistanceAsymmetry(0.5, "long");
    expect(farBelow.points).toBeGreaterThan(above.points);
  });

  it("inverts between sides at the same distance -- the core asymmetry this factor exists for", () => {
    const shortAbove = scoreMaDistanceAsymmetry(0.5, "short");
    const longAbove = scoreMaDistanceAsymmetry(0.5, "long");
    expect(shortAbove.points).toBeGreaterThan(longAbove.points);

    const shortFarBelow = scoreMaDistanceAsymmetry(-2, "short");
    const longFarBelow = scoreMaDistanceAsymmetry(-2, "long");
    expect(longFarBelow.points).toBeGreaterThan(shortFarBelow.points);
  });

  it("treats a missing MA-distance reading as zero rather than throwing", () => {
    const result = scoreMaDistanceAsymmetry(null, "long");
    expect(result.points).toBe(0);
  });
});

describe("scoreAdxRegimeAsymmetry", () => {
  it("scores a very-strong-trend (ADX 45) short higher than a weak-trend (ADX 10) short -- monotonic for shorts", () => {
    const veryStrong = scoreAdxRegimeAsymmetry(45, "short");
    const weak = scoreAdxRegimeAsymmetry(10, "short");
    expect(veryStrong.points).toBeGreaterThan(weak.points);
  });

  it("scores a very-strong-trend short much higher than a very-strong-trend long -- the core asymmetry, muted for longs", () => {
    const short = scoreAdxRegimeAsymmetry(45, "short");
    const long = scoreAdxRegimeAsymmetry(45, "long");
    expect(short.points).toBeGreaterThan(long.points);
    expect(long.points).toBe(0); // long gets nothing at ADX>=25 per the muted, mostly-flat long-side read
  });

  it("caps the long-side weight at half the short-side weight, even at its own best case", () => {
    const bestLong = scoreAdxRegimeAsymmetry(10, "long");
    const bestShort = scoreAdxRegimeAsymmetry(45, "short");
    expect(bestLong.points).toBeLessThan(bestShort.points);
  });

  it("treats a missing ADX reading as zero rather than throwing", () => {
    const result = scoreAdxRegimeAsymmetry(null, "short");
    expect(result.points).toBe(0);
  });
});

describe("scoreMomentumGrind", () => {
  it("scores mildly favorable momentum as the best bucket for a long", () => {
    const mild = scoreMomentumGrind(2, "long"); // 0 to 5, favorable
    const strong = scoreMomentumGrind(8, "long"); // 5+, favorable but "strong"
    const mildAgainst = scoreMomentumGrind(-2, "long"); // 0 to -5, against
    expect(mild.points).toBeGreaterThan(strong.points);
    expect(mild.points).toBeGreaterThan(mildAgainst.points);
  });

  it("scores mildly unfavorable momentum as the worst bucket -- worse than being strongly fought", () => {
    const mildAgainst = scoreMomentumGrind(-2, "long"); // 0 to -5, against
    const strongAgainst = scoreMomentumGrind(-8, "long"); // <-5, strongly against
    expect(strongAgainst.points).toBeGreaterThan(mildAgainst.points);
  });

  it("mirrors correctly for a short (favorable direction flipped)", () => {
    const mildFavorable = scoreMomentumGrind(-2, "short"); // negative net PPM favors a short
    const mildAgainst = scoreMomentumGrind(2, "short");
    expect(mildFavorable.points).toBeGreaterThan(mildAgainst.points);
  });

  it("treats a missing PPM reading as zero rather than throwing", () => {
    const result = scoreMomentumGrind(null, "long");
    expect(result.points).toBe(0);
  });
});

describe("scoreSetupV7", () => {
  it("returns a probability strictly between 0 and 1 for a mixed-strength setup", () => {
    const result = scoreSetupV7(features({ side: "short", distanceFromMa20Atr: -0.5, adx: 22, netPointsPerMinute: 3 }));
    expect(result.probability).toBeGreaterThan(0);
    expect(result.probability).toBeLessThan(1);
  });

  it("returns exactly 3 factors, one per mined pattern", () => {
    const result = scoreSetupV7(features());
    expect(result.factors.map((f) => f.name).sort()).toEqual(["adxRegimeAsymmetry", "maDistanceAsymmetry", "momentumGrind"]);
  });

  it("scores a setup aligned with all three short-favoring patterns much higher than the same setup on the long side", () => {
    const strongShort = scoreSetupV7(features({ side: "short", distanceFromMa20Atr: 0.5, adx: 45, netPointsPerMinute: -2 }));
    const sameFeaturesLong = scoreSetupV7(features({ side: "long", distanceFromMa20Atr: 0.5, adx: 45, netPointsPerMinute: -2 }));
    expect(strongShort.probability).toBeGreaterThan(sameFeaturesLong.probability);
  });

  it("never exceeds 0.85 probability for a long -- the ADX factor's long-side max is half the short-side max", () => {
    const bestPossibleLong = scoreSetupV7(features({ side: "long", distanceFromMa20Atr: -2, adx: 10, netPointsPerMinute: 2 }));
    expect(bestPossibleLong.probability).toBeLessThanOrEqual(0.85);
  });

  it("can reach 1.0 probability for a short at every factor's best case", () => {
    const bestPossibleShort = scoreSetupV7(features({ side: "short", distanceFromMa20Atr: 0.5, adx: 45, netPointsPerMinute: -2 }));
    expect(bestPossibleShort.probability).toBe(1.0);
  });
});

describe("evaluateSetup -- v7 dispatch", () => {
  it("routes version 'v7' through scoreSetupV7 and labels it rule_v7", async () => {
    const gated = await evaluateSetup(features({ side: "short", distanceFromMa20Atr: 0.5, adx: 45, netPointsPerMinute: -2 }), "v7", AT);
    expect(gated.modelUsed).toBe("rule_v7");
    expect(gated.v3Bucket).toBeNull();
    expect(gated.blockReason).toBeNull();
  });

  it("takes a strong v7 setup and skips a weak one, gated on the same threshold as other versions", async () => {
    const strong = await evaluateSetup(features({ side: "short", distanceFromMa20Atr: 0.5, adx: 45, netPointsPerMinute: -2 }), "v7", AT);
    const weak = await evaluateSetup(features({ side: "long", distanceFromMa20Atr: 0.5, adx: 45, netPointsPerMinute: 2 }), "v7", AT);
    expect(strong.probability).toBeGreaterThan(weak.probability);
  });
});
