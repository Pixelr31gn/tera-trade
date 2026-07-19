import { describe, expect, it } from "vitest";
import { classifyEma50Trend } from "../src/analytics/emaTrend.js";
import { computeRsi } from "../src/analytics/rsi.js";
import { computeBreakoutStrengthAdjustment, computeOrderFlowAdjustment, computeTimeframeAlignmentAdjustment, computeV3Bucket, scoreSetupV3Directional } from "../src/scoring/ruleScorerV3.js";
import { computeAdjustmentFromOutcomes } from "../src/scoring/v3HistoricalAdjustment.js";
import type { SetupFeatures } from "../src/scoring/features.js";
import type { OhlcBar } from "../src/regime/indicators.js";
import type { OrderFlowSnapshot } from "../src/browserWatch/orderFlowListener.js";

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
    marketStructureLabel: "strong_uptrend",
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
    timeframeTrends: {},
    ...overrides,
  };
}

/** A steady linear drift with mildly increasing volume -- enough bars for EMA50/RSI/ATR averages to be real, not warm-up noise. */
function makeDriftingBars(count: number, pointsPerBar: number, startPrice = 100, startVolume = 1000): OhlcBar[] {
  const bars: OhlcBar[] = [];
  let price = startPrice;
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  for (let i = 0; i < count; i++) {
    const open = price;
    price += pointsPerBar;
    const close = price;
    const high = Math.max(open, close) + Math.abs(pointsPerBar) * 0.2;
    const low = Math.min(open, close) - Math.abs(pointsPerBar) * 0.2;
    bars.push({ time: new Date(base + i * 60_000), open, high, low, close, volume: startVolume + i * 2 });
  }
  return bars;
}

describe("classifyEma50Trend", () => {
  it("reads bullish for a steady uptrend", () => {
    const bars = makeDriftingBars(120, 0.5);
    const trend = classifyEma50Trend(bars);
    expect(trend.label).toBe("bullish");
    expect(trend.slope).toBeGreaterThan(0);
  });

  it("reads bearish for a steady downtrend", () => {
    const bars = makeDriftingBars(120, -0.5);
    const trend = classifyEma50Trend(bars);
    expect(trend.label).toBe("bearish");
    expect(trend.slope).toBeLessThan(0);
  });

  it("reads neutral for flat/sideways bars", () => {
    const bars = makeDriftingBars(120, 0);
    const trend = classifyEma50Trend(bars);
    expect(trend.label).toBe("neutral");
  });

  it("returns nulls when there aren't enough bars for a 50-period EMA", () => {
    const bars = makeDriftingBars(10, 0.5);
    const trend = classifyEma50Trend(bars);
    expect(trend.ema50).toBeNull();
  });
});

describe("computeRsi", () => {
  it("reads near 100 for an unbroken string of up bars", () => {
    const bars = makeDriftingBars(30, 1);
    const series = computeRsi(bars);
    expect(series.at(-1)!).toBeGreaterThan(90);
  });

  it("reads near 0 for an unbroken string of down bars", () => {
    const bars = makeDriftingBars(30, -1);
    const series = computeRsi(bars);
    expect(series.at(-1)!).toBeLessThan(10);
  });
});

describe("scoreSetupV3Directional", () => {
  it("scores the bullish hypothesis higher than bearish in a strong uptrend", () => {
    const bars = makeDriftingBars(150, 0.6);
    const result = scoreSetupV3Directional(bars, features({ side: "long", adx: 35, marketStructureLabel: "strong_uptrend" }));
    expect(result.bullish.score).toBeGreaterThan(result.bearish.score);
  });

  it("scores the bearish hypothesis higher than bullish in a strong downtrend", () => {
    const bars = makeDriftingBars(150, -0.6);
    const result = scoreSetupV3Directional(bars, features({ side: "short", adx: 35, marketStructureLabel: "strong_downtrend" }));
    expect(result.bearish.score).toBeGreaterThan(result.bullish.score);
  });

  it("every factor stays within its declared point range", () => {
    const bars = makeDriftingBars(150, 0.3);
    const result = scoreSetupV3Directional(bars, features());
    for (const side of [result.bullish, result.bearish]) {
      for (const factor of side.factors) {
        expect(factor.points).toBeGreaterThanOrEqual(0);
        expect(factor.points).toBeLessThanOrEqual(factor.maxPoints);
      }
      expect(side.score).toBeGreaterThanOrEqual(0);
      expect(side.score).toBeLessThanOrEqual(100);
    }
  });

  it("factor max points sum to 100", () => {
    const bars = makeDriftingBars(150, 0.3);
    const result = scoreSetupV3Directional(bars, features());
    const totalMax = result.bullish.factors.reduce((sum, f) => sum + f.maxPoints, 0);
    expect(totalMax).toBe(100);
  });
});

describe("computeV3Bucket", () => {
  it("is deterministic for identical readings and side", () => {
    const bars = makeDriftingBars(150, 0.4);
    const result = scoreSetupV3Directional(bars, features());
    const a = computeV3Bucket(result.readings, "long");
    const b = computeV3Bucket(result.readings, "long");
    expect(a).toBe(b);
  });

  it("differs between long and short for the same readings", () => {
    const bars = makeDriftingBars(150, 0.4);
    const result = scoreSetupV3Directional(bars, features());
    expect(computeV3Bucket(result.readings, "long")).not.toBe(computeV3Bucket(result.readings, "short"));
  });
});

describe("computeAdjustmentFromOutcomes", () => {
  it("applies no adjustment below the minimum sample size", () => {
    const result = computeAdjustmentFromOutcomes(["executed_win", "executed_win", "executed_loss"]);
    expect(result.adjustmentPoints).toBe(0);
    expect(result.winRate).toBeNull();
  });

  it("reproduces the spec's worked example: ~73% win rate over 15 samples -> ~+7 points", () => {
    const outcomes = [...Array(11).fill("missed_win"), ...Array(4).fill("missed_loss")];
    const result = computeAdjustmentFromOutcomes(outcomes);
    expect(result.sampleSize).toBe(15);
    expect(result.winRate).toBeCloseTo(11 / 15);
    expect(result.adjustmentPoints).toBeCloseTo(7, 1);
  });

  it("applies a negative adjustment when similar setups mostly lost", () => {
    const outcomes = [...Array(2).fill("executed_win"), ...Array(8).fill("executed_loss")];
    const result = computeAdjustmentFromOutcomes(outcomes);
    expect(result.adjustmentPoints).toBeLessThan(0);
  });

  it("caps the adjustment at +/-15 points even for a 100% or 0% historical win rate", () => {
    const allWins = computeAdjustmentFromOutcomes(Array(10).fill("executed_win"));
    const allLosses = computeAdjustmentFromOutcomes(Array(10).fill("executed_loss"));
    expect(allWins.adjustmentPoints).toBe(15);
    expect(allLosses.adjustmentPoints).toBe(-15);
  });
});

describe("computeBreakoutStrengthAdjustment", () => {
  it("gives a long breakout the full +10 for closing exactly at the bar's high", () => {
    const bar: OhlcBar = { time: new Date(), open: 100, high: 105, low: 100, close: 105, volume: 1 };
    const result = computeBreakoutStrengthAdjustment(bar, "long");
    expect(result.adjustmentPoints).toBeCloseTo(10);
    expect(result.closeLocationValue).toBeCloseTo(1);
  });

  it("gives a long breakout the full -10 for closing exactly at the bar's low", () => {
    const bar: OhlcBar = { time: new Date(), open: 100, high: 105, low: 100, close: 100, volume: 1 };
    const result = computeBreakoutStrengthAdjustment(bar, "long");
    expect(result.adjustmentPoints).toBeCloseTo(-10);
  });

  it("mirrors for a short breakout -- closing near the low is strong, near the high is weak", () => {
    const bar: OhlcBar = { time: new Date(), open: 100, high: 105, low: 100, close: 100, volume: 1 };
    const result = computeBreakoutStrengthAdjustment(bar, "short");
    expect(result.adjustmentPoints).toBeCloseTo(10);
  });

  it("gives no adjustment for a close exactly in the middle of the bar's range", () => {
    const bar: OhlcBar = { time: new Date(), open: 100, high: 106, low: 100, close: 103, volume: 1 };
    const result = computeBreakoutStrengthAdjustment(bar, "long");
    expect(result.adjustmentPoints).toBeCloseTo(0);
  });

  it("returns a neutral zero adjustment for a zero-range bar instead of dividing by zero", () => {
    const bar: OhlcBar = { time: new Date(), open: 100, high: 100, low: 100, close: 100, volume: 1 };
    const result = computeBreakoutStrengthAdjustment(bar, "long");
    expect(result.adjustmentPoints).toBe(0);
    expect(Number.isFinite(result.closeLocationValue)).toBe(true);
  });
});

describe("computeOrderFlowAdjustment", () => {
  function snapshot(overrides: Partial<OrderFlowSnapshot> = {}): OrderFlowSnapshot {
    return {
      symbol: "ES",
      bestBidPrice: null,
      bestBidSize: null,
      bestAskPrice: null,
      bestAskSize: null,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
      tiltLongBias: null,
      tiltShortBias: null,
      ...overrides,
    };
  }

  it("gives no adjustment when there's no snapshot yet", () => {
    const result = computeOrderFlowAdjustment(null, "long");
    expect(result.adjustmentPoints).toBe(0);
  });

  it("gives a positive adjustment for a long when buy volume dominates", () => {
    const result = computeOrderFlowAdjustment(snapshot({ buyVolume: 90, sellVolume: 10, tradeCount: 10 }), "long");
    expect(result.adjustmentPoints).toBeGreaterThan(0);
  });

  it("gives a negative adjustment for a long when sell volume dominates", () => {
    const result = computeOrderFlowAdjustment(snapshot({ buyVolume: 10, sellVolume: 90, tradeCount: 10 }), "long");
    expect(result.adjustmentPoints).toBeLessThan(0);
  });

  it("stays within the documented +/-8 bound for extreme one-sided flow", () => {
    const result = computeOrderFlowAdjustment(snapshot({ buyVolume: 1000, sellVolume: 0, tradeCount: 50, bestBidSize: 500, bestAskSize: 0 }), "long");
    expect(result.adjustmentPoints).toBeCloseTo(8);
  });
});

describe("computeTimeframeAlignmentAdjustment", () => {
  it("gives no adjustment when there are no timeframe reads available yet", () => {
    const result = computeTimeframeAlignmentAdjustment({}, "long");
    expect(result.adjustmentPoints).toBe(0);
    expect(result.description).toContain("no timeframe reads available");
  });

  it("gives a positive adjustment for a long when timeframes agree", () => {
    const result = computeTimeframeAlignmentAdjustment({ "1d": { trendLabel: "up", confidence: 0.8 } }, "long");
    expect(result.adjustmentPoints).toBeGreaterThan(0);
  });

  it("gives a negative adjustment for a long when timeframes fight it", () => {
    const result = computeTimeframeAlignmentAdjustment({ "1d": { trendLabel: "down", confidence: 0.8 } }, "long");
    expect(result.adjustmentPoints).toBeLessThan(0);
  });

  it("reports the available/7 leg count in the description", () => {
    const result = computeTimeframeAlignmentAdjustment(
      { "1d": { trendLabel: "up", confidence: 0.8 }, "1h": { trendLabel: "up", confidence: 0.5 } },
      "long"
    );
    expect(result.description).toContain("2/7 available timeframes");
  });

  it("stays within the documented +/-12 bound for extreme full agreement", () => {
    const allUp = { "1d": { trendLabel: "up" as const, confidence: 1 }, "4h": { trendLabel: "up" as const, confidence: 1 } };
    const result = computeTimeframeAlignmentAdjustment(allUp, "long");
    expect(result.adjustmentPoints).toBeCloseTo(12);
  });
});
