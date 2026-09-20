import { describe, expect, it } from "vitest";
import {
  scoreSetupV6,
  scoreCorrectionBars,
  scoreEma20Proximity,
  scoreFibRetracement,
  scoreReversalBar,
  scoreMarketSpeed,
} from "../src/scoring/ruleScorerV6.js";
import { evaluateSetup } from "../src/scoring/gate.js";
import type { SetupFeatures } from "../src/scoring/features.js";
import type { OhlcBar } from "../src/regime/indicators.js";
import type { CorrectionLeg } from "../src/strategy/trendPullbackFib.js";

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
    marketStructureLabel: "weak_uptrend",
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

// ---- #1: correction-leg bar count (10 pts total, 3.3.../bar, capped at 3) ----
describe("scoreCorrectionBars", () => {
  it("scores 0 and explains a flat/insufficient EMA when direction is null", () => {
    const result = scoreCorrectionBars(null, null);
    expect(result.points).toBe(0);
    expect(result.description).toContain("no trend to measure a correction against");
  });
  it("scores 0 and explains no clean pullback found when direction is set but no leg exists", () => {
    const result = scoreCorrectionBars(null, "up");
    expect(result.points).toBe(0);
    expect(result.description).toContain("15m trend is rising");
    expect(result.description).toContain("pullback (red bars)");
  });
  it("mirrors the explanation for a falling trend", () => {
    const result = scoreCorrectionBars(null, "down");
    expect(result.description).toContain("15m trend is falling");
    expect(result.description).toContain("bounce (green bars)");
  });
  it("scores one bar's worth for a 1-bar leg", () => {
    const leg: CorrectionLeg = { startIndex: 10, endIndex: 10 };
    expect(scoreCorrectionBars(leg, "up").points).toBeCloseTo(10 / 3, 5);
  });
  it("scores the full 10 for a 3-bar leg", () => {
    const leg: CorrectionLeg = { startIndex: 10, endIndex: 12 };
    expect(scoreCorrectionBars(leg, "up").points).toBeCloseTo(10, 5);
  });
  it("caps at 10 for a leg longer than 3 bars", () => {
    const leg: CorrectionLeg = { startIndex: 5, endIndex: 12 }; // 8 bars
    expect(scoreCorrectionBars(leg, "up").points).toBeCloseTo(10, 5);
  });
});

// ---- #3: fib retracement (30 pts total) -- exact operator anchor points ----
describe("scoreFibRetracement", () => {
  it("scores 0 and explains no correction leg when that's the missing prerequisite", () => {
    const result = scoreFibRetracement(null, null, null);
    expect(result.points).toBe(0);
    expect(result.description).toContain("no correction leg found");
  });
  it("scores 0 and explains no trend leg when a correction leg exists but no trend leg precedes it", () => {
    const leg: CorrectionLeg = { startIndex: 10, endIndex: 12 };
    const result = scoreFibRetracement(null, leg, null);
    expect(result.points).toBe(0);
    expect(result.description).toContain("no valid trend leg precedes it");
  });
  it("scores 0 for anything over 60% retracement", () => {
    expect(scoreFibRetracement(60.01, null, null).points).toBe(0);
    expect(scoreFibRetracement(75, null, null).points).toBe(0);
  });
  it("scores exactly 30 (100%) at 59% retracement", () => {
    expect(scoreFibRetracement(59, null, null).points).toBeCloseTo(30, 5);
  });
  it("holds at 30 between 59% and 60% inclusive", () => {
    expect(scoreFibRetracement(59.5, null, null).points).toBeCloseTo(30, 5);
    expect(scoreFibRetracement(60, null, null).points).toBeCloseTo(30, 5);
  });
  it("scores exactly 3 (10%) at 39% retracement", () => {
    expect(scoreFibRetracement(39, null, null).points).toBeCloseTo(3, 5);
  });
  it("scores the midpoint of the ramp at 49% retracement", () => {
    expect(scoreFibRetracement(49, null, null).points).toBeCloseTo((3 + 30) / 2, 5);
  });
  it("is flat at 1.5 (5%) anywhere below 39%, including a real step at the boundary", () => {
    expect(scoreFibRetracement(38.99, null, null).points).toBeCloseTo(1.5, 5);
    expect(scoreFibRetracement(10, null, null).points).toBeCloseTo(1.5, 5);
    expect(scoreFibRetracement(0, null, null).points).toBeCloseTo(1.5, 5);
  });
});

// ---- #5: market speed (20 pts total) -- exact operator anchor points ----
describe("scoreMarketSpeed", () => {
  it("scores 0 with no reading", () => {
    expect(scoreMarketSpeed(null, "long").points).toBe(0);
  });
  it("scores 0 below the 0.5 floor, including negative (unfavorable) speed", () => {
    expect(scoreMarketSpeed(0.49, "long").points).toBe(0);
    expect(scoreMarketSpeed(-2, "long").points).toBe(0);
  });
  it("scores exactly 1 (1%) at 0.5 pts/min in the setup's favor", () => {
    expect(scoreMarketSpeed(0.5, "long").points).toBeCloseTo(1, 5);
  });
  it("scores the full 20 at 3.0 pts/min or more in the setup's favor", () => {
    expect(scoreMarketSpeed(3.0, "long").points).toBeCloseTo(20, 5);
    expect(scoreMarketSpeed(10, "long").points).toBeCloseTo(20, 5);
  });
  it("mirrors for shorts -- negative pts/min is favorable", () => {
    expect(scoreMarketSpeed(-3.0, "short").points).toBeCloseTo(20, 5);
    expect(scoreMarketSpeed(3.0, "short").points).toBe(0); // market moving up is UNfavorable for a short
  });
});

// ---- #2: rising 20 EMA proximity (20 pts total) ----
describe("scoreEma20Proximity", () => {
  // 30 bars oscillating +/-0.5 around 100 -- same numerically-verified shape
  // used elsewhere in this file: real (small, non-zero) ATR, last close
  // sitting close to its own 20 EMA. Works the same regardless of the
  // actual bar spacing (the math only cares about the close-price
  // sequence), so this doubles as both a "5m" and "15m" fixture.
  function buildNearBars(): OhlcBar[] {
    const start = AT.getTime();
    return Array.from({ length: 30 }, (_, i) => {
      const base = 100 + (i % 2 === 0 ? 0.5 : -0.5);
      return { time: new Date(start + i * 5 * 60_000), open: base, high: base + 0.5, low: base - 0.5, close: base, volume: 10 };
    });
  }

  // Same history, but the final bar jumps far away from where the EMA
  // actually is -- numerically verified elsewhere in this file (the
  // now-removed standalone EMA gate's tests) to land at ~6-8x ATR.
  function buildFarBars(): OhlcBar[] {
    const bars = buildNearBars();
    const last = bars.at(-1)!;
    bars[bars.length - 1] = { ...last, close: 130, high: 130.5, low: 129.5 };
    return bars;
  }

  it("scores 0 when the direction doesn't match the side (EMA not rising for a long)", () => {
    const result = scoreEma20Proximity(buildNearBars(), buildNearBars(), "down", "long");
    expect(result.points).toBe(0);
  });

  it("scores 0 when direction is null (flat/insufficient EMA)", () => {
    const result = scoreEma20Proximity(buildNearBars(), buildNearBars(), null, "long");
    expect(result.points).toBe(0);
  });

  it("scores near the full 20 when price sits close to a rising 20 EMA on both timeframes", () => {
    const result = scoreEma20Proximity(buildNearBars(), buildNearBars(), "up", "long");
    expect(result.points).toBeGreaterThan(15);
  });

  it("still scores well when 5m is near, regardless of 15m", () => {
    const result = scoreEma20Proximity(buildNearBars(), buildFarBars(), "up", "long");
    expect(result.points).toBeGreaterThan(15);
    expect(result.description).toContain("5m");
  });

  it("prioritizes 5m even when it's worse than 15m -- 5m isn't just \"used when closer,\" it's the primary reference", () => {
    const result = scoreEma20Proximity(buildFarBars(), buildNearBars(), "up", "long");
    // Before 2026-08-03's "prioritize the 5 ema" change, this would have
    // picked the closer (15m) reading and scored well. Now 5m wins outright
    // even though it's the worse of the two -- this fixture exists
    // specifically to prove that, not just "a reading was picked."
    expect(result.points).toBe(0);
    expect(result.description).toContain("5m");
    expect(result.description).not.toContain("15m");
  });

  it("scores low when price is far from the EMA on both timeframes", () => {
    const result = scoreEma20Proximity(buildFarBars(), buildFarBars(), "up", "long");
    expect(result.points).toBe(0);
  });

  it("scores 0 when there aren't enough bars for a 20 EMA reading on either timeframe", () => {
    const result = scoreEma20Proximity(buildNearBars().slice(0, 10), buildNearBars().slice(0, 10), "up", "long");
    expect(result.points).toBe(0);
  });

  it("still scores using whichever timeframe has enough bars", () => {
    const result = scoreEma20Proximity(buildNearBars().slice(0, 10), buildNearBars(), "up", "long");
    expect(result.points).toBeGreaterThan(15);
  });
});

// ---- #4: reversal-bar quality (20 pts total) ----
describe("scoreReversalBar", () => {
  const correctionEndBar15m: OhlcBar = { time: AT, open: 105, high: 106, low: 99, close: 100 }; // correction's last (red) 15m bar
  const triggerLevel = 106; // its high -- the break level for a long

  it("scores 0 when the correction leg / trigger level is unknown", () => {
    expect(scoreReversalBar([], null, null, "long").points).toBe(0);
  });

  it("scores 0 when the most recent 5m bar isn't green (for a long)", () => {
    const bars: OhlcBar[] = [{ time: AT, open: 102, high: 102, low: 100, close: 100 }]; // red/flat
    expect(scoreReversalBar(bars, correctionEndBar15m, triggerLevel, "long").points).toBe(0);
  });

  it("scores the 1-pt floor for a green bar that hasn't progressed past the correction's own close", () => {
    const bars: OhlcBar[] = [{ time: AT, open: 99, high: 100, low: 99, close: 99.5 }]; // green, still below zero=100
    const result = scoreReversalBar(bars, correctionEndBar15m, triggerLevel, "long");
    expect(result.points).toBeCloseTo(1, 5);
  });

  it("scores the full 20 for a bar closing at or above the trigger level", () => {
    const bars: OhlcBar[] = [{ time: AT, open: 104, high: 107, low: 104, close: 106.5 }]; // green, closes above 106
    const result = scoreReversalBar(bars, correctionEndBar15m, triggerLevel, "long");
    expect(result.points).toBeCloseTo(20, 5);
  });

  it("scores somewhere in between for partial progress", () => {
    // zero=100, target=106, close=103 -> 50% of the way
    const bars: OhlcBar[] = [{ time: AT, open: 101, high: 103.5, low: 101, close: 103 }];
    const result = scoreReversalBar(bars, correctionEndBar15m, triggerLevel, "long");
    expect(result.points).toBeCloseTo(1 + 0.5 * (20 - 1), 1);
  });

  it("mirrors for shorts -- a red bar breaking below the correction's low", () => {
    const shortCorrectionEndBar: OhlcBar = { time: AT, open: 95, high: 101, low: 94, close: 100 }; // green correction bar
    const shortTriggerLevel = 94; // its low
    const bars: OhlcBar[] = [{ time: AT, open: 99, high: 99, low: 93, close: 93.5 }]; // red, closes below 94
    const result = scoreReversalBar(bars, shortCorrectionEndBar, shortTriggerLevel, "short");
    expect(result.points).toBeCloseTo(20, 5);
  });
});

// ---- Integration: scoreSetupV6 wiring ----
const TOO_FEW_BARS: OhlcBar[] = Array.from({ length: 5 }, (_, i) => ({
  time: new Date(AT.getTime() + i * 5 * 60_000), open: 100, high: 101, low: 99, close: 100, volume: 10,
}));

describe("scoreSetupV6 -- integration", () => {
  it("returns 0 probability with all five factors present (each explaining why) when nothing can be measured", () => {
    const result = scoreSetupV6(features({}), TOO_FEW_BARS);
    expect(result.probability).toBe(0);
    expect(result.factors.map((f) => f.name).sort()).toEqual(
      ["correctionLegBars", "fibRetracement", "marketSpeed", "reversalBarQuality", "rising20EmaProximity"].sort()
    );
  });

  it("sums the five factors' points into probability = total/100", () => {
    const result = scoreSetupV6(features({ netPointsPerMinute: 5 }), TOO_FEW_BARS);
    const total = result.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(result.probability).toBeCloseTo(total / 100, 10);
    // Only marketSpeed can score anything with no pattern structure at all --
    // the other four all require a correction/trend leg this fixture doesn't have.
    expect(result.probability).toBeCloseTo(20 / 100, 5);
  });
});

describe("evaluateSetup -- v6 dispatch", () => {
  it("routes version 'v6' through scoreSetupV6 using only bars -- no longer needs v1/v2/v3/v5", async () => {
    const result = await evaluateSetup(features({}), "v6", AT, { bars: TOO_FEW_BARS });
    expect(result.modelUsed).toBe("rule_v6");
    expect(result.v3Bucket).toBeNull();
    expect(result.blockReason).toBeNull();
  });

  it("throws if bars aren't provided", async () => {
    await expect(evaluateSetup(features({}), "v6", AT)).rejects.toThrow(/extra\.bars is required/);
  });
});
