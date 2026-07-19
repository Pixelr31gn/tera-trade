import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/engine.js";
import type { AccountRiskState, RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { NewsRiskStatus } from "../src/news/risk.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const NO_NEWS: NewsRiskStatus = { inRiskWindow: false, nearestEventName: null, nearestEventTime: null, minutesToEvent: null, impact: null };

// Builds two clean V-shapes (or inverted-V for a high) bottoming at exactly
// `price`, far enough apart to register as two independent pivots but close
// enough to cluster into one level -- MIN_LEVEL_TOUCHES now requires at
// least 2 touches before a level counts as real (see
// analytics/supportResistance.ts), so a single isolated swing point is no
// longer enough to pass the risk engine's proximity gate on its own.
function barsWithPivotLowNear(price: number): OhlcBar[] {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  const dip = (blockStart: number) =>
    Array.from({ length: 9 }, (_, i) => {
      const low = price + Math.abs(i - 4) * 2;
      return { time: new Date(base + (blockStart + i) * 60_000), open: low + 1, high: low + 3, low, close: low + 1, volume: 100 };
    });
  return [...dip(0), ...dip(9)];
}

function barsWithPivotHighNear(price: number): OhlcBar[] {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  const peak = (blockStart: number) =>
    Array.from({ length: 9 }, (_, i) => {
      const high = price - Math.abs(i - 4) * 2;
      return { time: new Date(base + (blockStart + i) * 60_000), open: high - 1, high, low: high - 3, close: high - 1, volume: 100 };
    });
  return [...peak(0), ...peak(9)];
}

function accountState(overrides: Partial<AccountRiskState> = {}): AccountRiskState {
  return {
    currentEquity: new Decimal(50000),
    peakEquity: new Decimal(50000),
    dailyStartingEquity: new Decimal(50000),
    consecutiveLosses: 0,
    tradesToday: 0,
    ...overrides,
  };
}

const BASE_LIMITS: RiskLimitsConfig = {
  perTradeRiskPct: new Decimal("0.5"),
  maxDailyLossPct: new Decimal("3"),
  maxTrailingDrawdownPct: new Decimal("6"),
  maxConsecutiveLosses: 3,
  maxDailyTrades: 13,
  maxPositionSize: 10,
};

describe("RiskEngine.assessNewTrade with fixed-dollar risk/profit", () => {
  it("sizes the position from a fixed dollar risk budget instead of a percentage of equity", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };

    // ATR-based stop distance of 10 points on MNQ (pointValue $2) -- risk/contract = $20 -> floor(50/20) = 2 contracts.
    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667), // 1.5x ATR default multiplier -> ~10 point stop
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19997), // 3 points below entry -- well within the 1.0x ATR (6.667) gate
    });

    expect(assessment.approved).toBe(true);
    expect(assessment.quantity).toBe(2);
    expect(assessment.reason).toContain("$50");
  });

  it("sets the take-profit price from a fixed dollar profit target, reflecting the actual sized quantity", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50"), perTradeProfitDollars: new Decimal("120") };

    const entryPrice = new Decimal(20000);
    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice,
      atrValue: new Decimal(6.667),
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19997),
    });

    expect(assessment.quantity).toBe(2);
    // $120 profit / (2 contracts * $2/point) = 30 points above entry.
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.plus(30).toNumber(), 1);
  });

  it("mirrors the fixed dollar profit target below entry for a short", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50"), perTradeProfitDollars: new Decimal("120") };

    const entryPrice = new Decimal(20000);
    const assessment = engine.assessNewTrade({
      side: "short",
      entryPrice,
      atrValue: new Decimal(6.667),
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20003), // 3 points above entry -- resistance, relevant for a short
    });

    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.minus(30).toNumber(), 1);
  });

  it("falls back to the R:R-based take-profit when no fixed profit target is configured", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };

    const entryPrice = new Decimal(20000);
    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice,
      atrValue: new Decimal(6.667),
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19997),
    });

    // Default takeProfitRMultiple is 3.0x the stop distance -- should NOT be the fixed-dollar-derived 30pt target.
    const stopDistance = entryPrice.minus(assessment.stopPrice!).abs();
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.plus(stopDistance.times(3)).toNumber(), 1);
  });

  it("respects the fixed-dollar daily loss circuit breaker ahead of sizing", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50"), maxDailyLossDollars: new Decimal("650") };

    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState({ currentEquity: new Decimal(49300), dailyStartingEquity: new Decimal(50000) }), // -$700 today
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: [], // circuit breaker fires before the S/R check is ever reached
    });

    expect(assessment.approved).toBe(false);
    expect(assessment.tripKillSwitch).toBe(true);
  });
});

describe("RiskEngine.assessNewTrade -- support/resistance proximity gate", () => {
  const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };

  it("rejects a long with no nearby support level at all (flat bars, no pivots)", () => {
    const engine = new RiskEngine();
    const flatBars: OhlcBar[] = Array.from({ length: 20 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 0, 1, 0, i)),
      open: 20000, high: 20000, low: 20000, close: 20000, volume: 100,
    }));
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: flatBars,
    });
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain("no support level found");
  });

  it("rejects a long whose entry is too far from the nearest support level", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19950), // 50 points away -- 7.5x ATR, well past the 1.0x gate
    });
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain("x ATR from the nearest support level");
  });

  it("approves a long whose entry sits within 1.0x ATR of a real support level", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19997),
    });
    expect(assessment.approved).toBe(true);
    expect(assessment.nearestSrLevel?.type).toBe("support");
  });

  it("does not treat a resistance level above the entry as relevant for a long", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20003), // only a resistance level exists near entry, no relevant support
    });
    // Either "no support level found" or "too far from the nearest support" is
    // correct here -- the fixture's mirrored peak shape can incidentally form
    // a weak, distant support pivot at its own low-side edges, but either way
    // a resistance level above entry must never approve a long.
    expect(assessment.approved).toBe(false);
  });

  it("approves a short whose entry sits within 1.0x ATR of a real resistance level", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "short", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20003),
    });
    expect(assessment.approved).toBe(true);
    expect(assessment.nearestSrLevel?.type).toBe("resistance");
  });
});

describe("RiskEngine.assessNewTrade -- breakout signal gate", () => {
  const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };

  it("approves a short breakout entered close to the validated (2+ touch) level it broke, even with no other nearby resistance", () => {
    const engine = new RiskEngine();
    // A real support level at 20003 (touched twice, per barsWithPivotHighNear's
    // two-block shape -- see its top comment) that price has just broken below;
    // entry sits just past it, not near any unrelated resistance level.
    const assessment = engine.assessNewTrade({
      side: "short",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "breakout",
      breakoutLevelPrice: new Decimal(20003),
      accountState: accountState(),
      limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20003),
    });
    expect(assessment.approved).toBe(true);
  });

  it("rejects a breakout against a level that was only ever touched once (not a validated S/R zone)", () => {
    const engine = new RiskEngine();
    // A single, unmirrored pivot high -- exactly the "1 touches" case that
    // was previously accepted as a real level and caused the risk engine to
    // reject a strengthening real breakout against an unrelated level instead.
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const singlePivotBars: OhlcBar[] = Array.from({ length: 9 }, (_, i) => {
      const high = 20003 - Math.abs(i - 4) * 2;
      return { time: new Date(base + i * 60_000), open: high - 1, high, low: high - 3, close: high - 1, volume: 100 };
    });
    const assessment = engine.assessNewTrade({
      side: "short",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "breakout",
      breakoutLevelPrice: new Decimal(20003),
      accountState: accountState(),
      limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: singlePivotBars,
    });
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain("not a validated support/resistance zone");
  });
});
