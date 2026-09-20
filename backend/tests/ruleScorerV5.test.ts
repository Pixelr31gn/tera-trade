import { describe, expect, it } from "vitest";
import { scoreSetupV5 } from "../src/scoring/ruleScorerV5.js";
import { evaluateSetup } from "../src/scoring/gate.js";
import type { SetupFeatures } from "../src/scoring/features.js";

// evaluateSetup requires an explicit `at` (see v3HistoricalAdjustment.ts) --
// the v5 dispatch path never reads it, so any fixed timestamp works.
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
    ema20Ema200Regime: null,
    ...overrides,
  };
}

describe("scoreSetupV5 -- ADX regime asymmetry", () => {
  it("scores a very-strong-trend short much higher than a very-strong-trend long (the core asymmetry)", () => {
    const short = scoreSetupV5(features({ side: "short", adx: 45 }));
    const long = scoreSetupV5(features({ side: "long", adx: 45 }));
    expect(short.probability).toBeGreaterThan(long.probability);
  });

  it("scores a very-strong-trend short higher than a developing-trend short", () => {
    const veryStrong = scoreSetupV5(features({ side: "short", adx: 45 }));
    const developing = scoreSetupV5(features({ side: "short", adx: 20 }));
    expect(veryStrong.probability).toBeGreaterThan(developing.probability);
  });

  it("treats a missing ADX reading as neutral rather than throwing", () => {
    const result = scoreSetupV5(features({ adx: null }));
    const factor = result.factors.find((f) => f.name === "adxRegimeAsymmetry")!;
    expect(factor.contribution).toBe(0);
  });
});

describe("scoreSetupV5 -- weak-trend fade", () => {
  it("scores a short into a weak uptrend higher than a short into a weak downtrend", () => {
    const fade = scoreSetupV5(features({ side: "short", marketStructureLabel: "weak_uptrend" }));
    const withTrend = scoreSetupV5(features({ side: "short", marketStructureLabel: "weak_downtrend" }));
    expect(fade.probability).toBeGreaterThan(withTrend.probability);
  });

  it("scores a long into a weak downtrend higher than a long into a weak uptrend", () => {
    const fade = scoreSetupV5(features({ side: "long", marketStructureLabel: "weak_downtrend" }));
    const withTrend = scoreSetupV5(features({ side: "long", marketStructureLabel: "weak_uptrend" }));
    expect(fade.probability).toBeGreaterThan(withTrend.probability);
  });
});

describe("scoreSetupV5 -- price-action normalcy", () => {
  it("scores a normal candle higher than a dramatic one, for both sides", () => {
    const normalLong = scoreSetupV5(features({ side: "long", priceActionLabel: "normal" }));
    const dojiLong = scoreSetupV5(features({ side: "long", priceActionLabel: "indecision_doji" }));
    expect(normalLong.probability).toBeGreaterThan(dojiLong.probability);

    const normalShort = scoreSetupV5(features({ side: "short", priceActionLabel: "normal" }));
    const bearishBodyShort = scoreSetupV5(features({ side: "short", priceActionLabel: "strong_bearish_body" }));
    expect(normalShort.probability).toBeGreaterThan(bearishBodyShort.probability);
  });
});

describe("scoreSetupV5 -- factor bounds and shape", () => {
  it("keeps every factor's contribution within its own weight's +/- bound", () => {
    const result = scoreSetupV5(features({ side: "short", adx: 45, marketStructureLabel: "weak_uptrend", priceActionLabel: "strong_bearish_body" }));
    const bounds: Record<string, number> = { adxRegimeAsymmetry: 2.0, weakTrendFade: 1.3, priceActionNormalcy: 0.7 };
    for (const factor of result.factors) {
      const bound = bounds[factor.name];
      expect(bound).toBeDefined();
      expect(Math.abs(factor.contribution)).toBeLessThanOrEqual(bound!);
    }
  });

  it("returns a probability strictly between 0 and 1", () => {
    const result = scoreSetupV5(features({ side: "short", adx: 45, marketStructureLabel: "weak_uptrend" }));
    expect(result.probability).toBeGreaterThan(0);
    expect(result.probability).toBeLessThan(1);
  });
});

describe("evaluateSetup -- v5 dispatch", () => {
  it("routes version 'v5' through scoreSetupV5 and labels it rule_v5", async () => {
    const gated = await evaluateSetup(features({ side: "short", adx: 45, marketStructureLabel: "weak_uptrend", priceActionLabel: "normal" }), "v5", AT);
    expect(gated.modelUsed).toBe("rule_v5");
    expect(gated.v3Bucket).toBeNull();
    expect(gated.blockReason).toBeNull();
  });

  it("takes a strong v5 setup and skips a weak one, gated on the same threshold as other versions", async () => {
    const strong = await evaluateSetup(features({ side: "short", adx: 45, marketStructureLabel: "weak_uptrend", priceActionLabel: "normal" }), "v5", AT);
    const weak = await evaluateSetup(features({ side: "long", adx: 45, marketStructureLabel: "weak_uptrend", priceActionLabel: "indecision_doji" }), "v5", AT);
    expect(strong.probability).toBeGreaterThan(weak.probability);
  });
});
