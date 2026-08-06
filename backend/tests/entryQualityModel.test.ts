import { describe, expect, it } from "vitest";
import { buildEntryLadder, scoreEntryCandidate, scoreEntryLadder, selectBestEntry } from "../src/execution/entryQualityModel.js";
import type { FairValueMap } from "../src/execution/fairValueMap.js";
import type { EmaTrend } from "../src/analytics/emaTrend.js";

function fvm(overrides: Partial<FairValueMap> = {}): FairValueMap {
  return {
    currentPrice: 20000,
    atrValue: 10,
    srLevels: [],
    volumeProfile: { levels: [], poc: null, valueAreaHigh: null, valueAreaLow: null, highVolumeNodes: [], lowVolumeNodes: [] },
    sessionVwap: 20000,
    rollingVwap: 20000,
    bollinger: { middle: 20000, upper: 20020, lower: 19980, bandwidth: 0.002 },
    keltner: { middle: 20000, upper: 20020, lower: 19980 },
    absorption: { detected: false, side: null, description: "none" },
    deltaDivergence: { divergent: false, cumulativeDelta: 0, description: "none" },
    rsi: 50,
    ...overrides,
  };
}

const NEUTRAL_TREND: EmaTrend = { ema: 20000, slope: null, label: "neutral" };
const BULLISH_TREND: EmaTrend = { ema: 19950, slope: 0.01, label: "bullish" };

describe("scoreEntryCandidate", () => {
  it("keeps every factor within its declared point range", () => {
    const result = scoreEntryCandidate({ price: 19990, side: "long", stopPrice: 19960, targetPrice: 20080, emaTrend: BULLISH_TREND, fvm: fvm() });
    for (const factor of result.factors) {
      expect(factor.points).toBeGreaterThanOrEqual(0);
      expect(factor.points).toBeLessThanOrEqual(factor.maxPoints);
    }
  });

  it("scores a trend-aligned candidate higher than a counter-trend one, all else equal", () => {
    const aligned = scoreEntryCandidate({ price: 19990, side: "long", stopPrice: 19960, targetPrice: 20080, emaTrend: BULLISH_TREND, fvm: fvm() });
    const counterTrend = scoreEntryCandidate({
      price: 19990,
      side: "long",
      stopPrice: 19960,
      targetPrice: 20080,
      emaTrend: { ema: 20050, slope: -0.01, label: "bearish" },
      fvm: fvm(),
    });
    expect(aligned.score).toBeGreaterThan(counterTrend.score);
  });

  it("scores a tighter risk:reward higher than a worse one", () => {
    const tight = scoreEntryCandidate({ price: 19990, side: "long", stopPrice: 19980, targetPrice: 20080, emaTrend: NEUTRAL_TREND, fvm: fvm() }); // 9:1
    const loose = scoreEntryCandidate({ price: 19990, side: "long", stopPrice: 19900, targetPrice: 20080, emaTrend: NEUTRAL_TREND, fvm: fvm() }); // ~1:1
    expect(tight.score).toBeGreaterThan(loose.score);
  });

  it("scores zero risk:reward points when entry is at or past the stop", () => {
    const result = scoreEntryCandidate({ price: 19960, side: "long", stopPrice: 19960, targetPrice: 20080, emaTrend: NEUTRAL_TREND, fvm: fvm() });
    const rrFactor = result.factors.find((f) => f.name === "riskReward")!;
    expect(rrFactor.points).toBe(0);
  });
});

describe("buildEntryLadder", () => {
  it("builds candidates below current price for a long (waiting for a pullback)", () => {
    const ladder = buildEntryLadder(20000, 0.25, "long", 4);
    expect(ladder[0]).toBe(20000);
    expect(ladder.every((p) => p <= 20000)).toBe(true);
    expect(ladder.length).toBe(5);
  });

  it("builds candidates above current price for a short", () => {
    const ladder = buildEntryLadder(20000, 0.25, "short", 4);
    expect(ladder[0]).toBe(20000);
    expect(ladder.every((p) => p >= 20000)).toBe(true);
  });
});

describe("scoreEntryLadder / selectBestEntry", () => {
  it("scores every rung and selects the highest-scoring one above threshold", () => {
    const scores = scoreEntryLadder({
      currentPrice: 20000,
      tickSize: 0.25,
      side: "long",
      stopPrice: 19960,
      targetPrice: 20120,
      emaTrend: BULLISH_TREND,
      fvm: fvm(),
      ticksEachSide: 20,
    });
    expect(scores.length).toBe(21);
    const best = selectBestEntry(scores, 0);
    expect(best).not.toBeNull();
    expect(scores.every((s) => s.score <= best!.score)).toBe(true);
  });

  it("returns null when nothing clears the threshold", () => {
    const scores = scoreEntryLadder({
      currentPrice: 20000,
      tickSize: 0.25,
      side: "long",
      stopPrice: 19960,
      targetPrice: 20120,
      emaTrend: BULLISH_TREND,
      fvm: fvm(),
      ticksEachSide: 5,
    });
    expect(selectBestEntry(scores, 1000)).toBeNull();
  });
});
