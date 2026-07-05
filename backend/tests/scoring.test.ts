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
});
