import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/engine.js";
import { DEFAULT_CONFIDENCE_TIERS } from "../src/risk/sizing.js";
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

    // Quantity now comes from the confidence tier (75%+ avg -> 2 contracts,
    // default tiers 65/71/82% -> 65/75/85% 2026-08-02, see
    // risk/sizing.ts's computeConfidenceTierQuantity), not the dollar
    // budget -- the dollar math ($50 / $20 risk-per-contract) is still
    // computed and reported in the reason for reference only.
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
      bars: barsWithPivotLowNear(19990), // 10 points below entry -- 1.5x ATR, inside the 0.25x-1.95x ATR band
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("2.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
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
      bars: barsWithPivotLowNear(19990),
      averageProbability: 0.75, // 75%+ tier -> 2 contracts
      takeProfitRMultiple: new Decimal("2.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
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
      bars: barsWithPivotHighNear(20010), // 10 points above entry -- 1.5x ATR, inside the 0.25x-1.95x ATR band
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("2.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
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
      bars: barsWithPivotLowNear(19990),
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("2.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
    });

    // 2.0x the stop distance is SystemState.takeProfitRMultiple's seeded
    // default (2026-07-29, operator request tied to v5 becoming a required
    // execution gate -- see its own comment; made operator-adjustable
    // 2026-08-02) -- should NOT be the fixed-dollar-derived 30pt target, and
    // NOT stops.ts's own bare default of 3.0x either.
    const stopDistance = entryPrice.minus(assessment.stopPrice!).abs();
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.plus(stopDistance.times(2)).toNumber(), 1);
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
      bars: barsWithPivotLowNear(19950), // 50 points away -- 7.5x ATR, well past the 1.95x ceiling
    });
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain("x ATR from the nearest support level");
  });

  it("rejects a long whose entry sits too close to the nearest support level (under the 0.25x ATR floor)", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19999), // 1 point away -- 0.15x ATR, under the 0.25x floor
    });
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain("too close");
  });

  it("approves a long whose entry sits within the 0.25x-1.95x ATR band of a real support level", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19990), // 10 points away -- 1.5x ATR, inside the band
    });
    expect(assessment.approved).toBe(true);
    expect(assessment.nearestSrLevel?.type).toBe("support");
  });

  it("does not treat a resistance level above the entry as relevant for a long", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      // Shifted well above entry (not 20003) so the fixture's mirrored-shape
      // low-side edges (price-11) never dip down near/below entry either --
      // otherwise this coincidentally forms an incidental support pivot whose
      // distance-from-entry keeps landing right on whatever MAX_ENTRY_DISTANCE_ATR
      // happens to be tuned to (hit once already at 1.2x, again at 1.25x).
      // Pushing the whole shape away from entry removes the coincidence
      // instead of just dodging today's specific gate value.
      bars: barsWithPivotHighNear(20030),
    });
    // Either "no support level found" or "too far from the nearest support" is
    // correct here -- but either way, a resistance level above entry must
    // never approve a long.
    expect(assessment.approved).toBe(false);
  });

  it("approves a short whose entry sits within the 0.25x-1.95x ATR band of a real resistance level", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "short", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20010),
    });
    expect(assessment.approved).toBe(true);
    expect(assessment.nearestSrLevel?.type).toBe("resistance");
  });

  // 2026-08-06 (operator request, 24h-boxed): srProximityGateSuspended skips
  // both the ceiling and floor above -- see risk/engine.ts's comment on that
  // param and engine/loop.ts's isSrProximityGateSuspended for the expiry.
  it("approves a long past the 1.95x ATR ceiling when srProximityGateSuspended is true", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19950), // 7.5x ATR -- normally rejected, see the ceiling test above
      srProximityGateSuspended: true,
    });
    expect(assessment.approved).toBe(true);
  });

  it("approves a long under the 0.25x ATR floor when srProximityGateSuspended is true", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19999), // 0.15x ATR -- normally rejected, see the floor test above
      srProximityGateSuspended: true,
    });
    expect(assessment.approved).toBe(true);
  });

  it("still rejects when no level exists at all, even with srProximityGateSuspended -- only the distance band is suspended, not the validation requirement", () => {
    const engine = new RiskEngine();
    const flatBars: OhlcBar[] = Array.from({ length: 20 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 0, 1, 0, i)),
      open: 20000, high: 20000, low: 20000, close: 20000, volume: 100,
    }));
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice: new Decimal(20000), atrValue: new Decimal(6.667), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: flatBars,
      srProximityGateSuspended: true,
    });
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain("no support level found");
  });
});

describe("RiskEngine.assessNewTrade -- breakout signal gate", () => {
  const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };

  it("approves a short breakout entered close to the validated (2+ touch) level it broke, even with no other nearby resistance", () => {
    const engine = new RiskEngine();
    // A real resistance level at 20010 (touched twice, per barsWithPivotHighNear's
    // two-block shape -- see its top comment) that price has just broken below;
    // entry sits 10 points past it (1.5x ATR, inside the 0.25x-1.95x band), not
    // near any unrelated resistance level.
    const assessment = engine.assessNewTrade({
      side: "short",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "breakout",
      breakoutLevelPrice: new Decimal(20010),
      accountState: accountState(),
      limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20010),
    });
    expect(assessment.approved).toBe(true);
  });

  it("approves a short breakout even when it's run well past MAX_ENTRY_DISTANCE_ATR from the broken level -- 2026-08-01: the ceiling is reversal-only now, since a breakout running far from the level it broke is the strategy working, not a stale setup (see risk/engine.ts's comment on the real ES incident this fixes)", () => {
    const engine = new RiskEngine();
    // A validated (2+ touch) resistance level at 20025 that price broke below;
    // entry sits 25 points past it -- 3.75x ATR, well beyond the old 1.95x
    // ceiling that used to reject this.
    const assessment = engine.assessNewTrade({
      side: "short",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "breakout",
      breakoutLevelPrice: new Decimal(20025),
      accountState: accountState(),
      limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20025),
    });
    expect(assessment.approved).toBe(true);
  });

  it("still rejects a reversal at that same extended distance -- the ceiling stays reversal-only, not removed outright", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "short",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "reversal",
      breakoutLevelPrice: null,
      accountState: accountState(),
      limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20025),
    });
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain(`needs to be within ${1.95}x ATR`);
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
