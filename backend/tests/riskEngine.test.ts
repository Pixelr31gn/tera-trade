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
      // `high` is intentionally monotonically increasing across the WHOLE
      // series (blockStart + i, never repeating), not just low + 3 -- two
      // identical dip() blocks back to back used to give `high` (as low + 3)
      // the exact same V-shape as `low`, and the shared value at the block
      // boundary tied for the window's local max, producing a spurious
      // 2-touch "resistance" level this fixture was never meant to have.
      // Found 2026-08-11 when new take-profit targeting logic
      // (risk/engine.ts) started reading the resistance side of what was
      // meant to be a support-only fixture -- a monotonic `high` can never
      // be a window's local max, so no pivot high is ever detected here.
      const high = low + 3 + blockStart + i;
      return { time: new Date(base + (blockStart + i) * 60_000), open: low + 1, high, low, close: low + 1, volume: 100 };
    });
  return [...dip(0), ...dip(9)];
}

function barsWithPivotHighNear(price: number): OhlcBar[] {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  const peak = (blockStart: number) =>
    Array.from({ length: 9 }, (_, i) => {
      const high = price - Math.abs(i - 4) * 2;
      // Mirrors barsWithPivotLowNear's fix above -- `low` monotonically
      // decreasing across the whole series instead of a mirrored high - 3,
      // so it can never tie for a window's local min and never registers a
      // spurious support pivot.
      const low = high - 3 - blockStart - i;
      return { time: new Date(base + (blockStart + i) * 60_000), open: high - 1, high, low, close: high - 1, volume: 100 };
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
      // 3.0 clears MIN_REWARD_RISK_RATIO by construction (2026-09-08,
      // stops.ts) -- target is always stop x takeProfitRMultiple here (no
      // resistance pivot exists in this fixture to override it) -- see the
      // dedicated describe block below for tests that exercise that floor
      // and the S/R-override derivation directly.
      takeProfitRMultiple: new Decimal("3.0"),
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
      // 6.5, not 6.667 (2026-09-08) -- 6.667 x 1.5 = 10.0005pt, which lands
      // 0.0015pt on the wrong side of this test's own $120/2-contract = 30pt
      // fixed target's 3:1 floor (MIN_REWARD_RISK_RATIO, uncapped stop as of
      // the same date) -- an artifact of 6.667 not being an exact 1/1.5
      // fraction, not a real business-logic conflict (this profitDollars
      // path is dormant in production). 6.5 x 1.5 = 9.75pt, comfortably
      // clear of the 10pt boundary.
      atrValue: new Decimal(6.5),
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19990), // 10pt away -- 1.54x ATR(6.5), still inside the 0.25x-1.95x band
      averageProbability: 0.75, // 75%+ tier -> 2 contracts
      takeProfitRMultiple: new Decimal("3.0"), // inert here -- profitDollars overrides the R-multiple target outright
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
      atrValue: new Decimal(6.5), // see the long test above for why not 6.667
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotHighNear(20010), // 10 points above entry -- 1.54x ATR(6.5), inside the 0.25x-1.95x band
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("3.0"), // inert here -- profitDollars overrides the R-multiple target outright
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
      atrValue: new Decimal(6.667), // still 1.5x ATR from the support pivot below -- satisfies the entry-proximity band
      // A real structural stop (3pt) tighter than the ATR-based one
      // (~10pt) -- structure wins, per computeInitialStop's own tighter-of
      // rule.
      structureSwingPrice: entryPrice.minus(3),
      signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19990),
      averageProbability: 0.75,
      // 4.0, distinct from both SystemState's old 2.0 default and stops.ts's
      // own bare 3.0 fallback -- a pass here can only mean this injected
      // value actually flowed through (4.0 x 3pt stop = 12pt), not either of
      // the other two numbers (2.0 x 3 = 6, below the new floor; 3.0 x 3 = 9,
      // the floor exactly).
      takeProfitRMultiple: new Decimal("4.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
    });

    // See this test's setup comment: SystemState.takeProfitRMultiple (here,
    // 4.0) is what's actually used -- should NOT be the fixed-dollar-derived
    // 30pt target, and NOT stops.ts's own bare default of 3.0x either.
    const stopDistance = entryPrice.minus(assessment.stopPrice!).abs();
    expect(stopDistance.toNumber()).toBeCloseTo(3, 4); // confirms the uncapped structural stop, not the ~10pt ATR one
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.plus(stopDistance.times(4)).toNumber(), 1);
    // barsWithPivotLowNear(19990) has no resistance pivots at all -- no real
    // target-direction level exists, so this correctly falls back to the
    // generic multiple above rather than blocking the trade (2026-08-11 S/R
    // take-profit targeting, see the dedicated describe block below).
    expect(assessment.targetSrLevel).toBeNull();
  });

  it("no longer blocks or trips the kill switch on the fixed-dollar daily loss circuit breaker (2026-08-17: circuit breakers are computed but no longer acted on -- only the S/R gate and zero-sizing can still block a trade)", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50"), maxDailyLossDollars: new Decimal("650") };

    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState({ currentEquity: new Decimal(49300), dailyStartingEquity: new Decimal(50000) }), // -$700 today, well past the $650 daily loss limit -- no longer matters
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: [], // no S/R levels either -- this is rejected for THAT reason instead, not the blown daily-loss limit
    });

    expect(assessment.approved).toBe(false);
    expect(assessment.tripKillSwitch).toBe(false);
    expect(assessment.reason).not.toContain("daily loss");
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
    // entry sits 25 points past it -- 3.75x ATR, well beyond the 2.75x
    // ceiling.
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
    expect(assessment.reason).toContain(`needs to be within ${2.75}x ATR`);
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

// 2026-08-11 (operator request: stop/target "should all score based on where
// price is actually headed towards"). Take-profit targets the nearest real,
// 2+-touch S/R level in the trade's favor instead of a blind R-multiple --
// see risk/engine.ts's comment on this block for the full reasoning.
//
// 2026-09-08 (operator instruction: "the 1:3 should be calculated based on
// the tp recommendation... dont do a fixed 15pt to 5pt"): a validated real
// level is now ALWAYS used once found -- the stop is DERIVED from its real
// distance (level distance / MIN_REWARD_RISK_RATIO) instead of the level
// being checked against a pre-existing stop and rejected/falling back to the
// generic multiple when the pairing came up short. See risk/engine.ts's
// comment on this same change for the full history of the reject-based
// mechanism this retired.
describe("RiskEngine.assessNewTrade -- S/R-based take-profit targeting", () => {
  const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };
  const ATR = new Decimal(6.667);
  const entryPrice = new Decimal(20000);

  // Support at 19990 (validates the long's entry, 1.5x ATR away, inside the
  // 0.25x-1.95x band) AND resistance at 20015 (the real target ahead of
  // price) in the same bar series -- concatenating the two existing pivot
  // fixtures is safe here: each shape's true extreme sits well clear of the
  // PIVOT_LOOKAROUND=3 window at the seam between them. The real pivot this
  // shape produces clusters at 20016, not exactly 20015 (confirmed
  // empirically, computeSupportResistanceLevels' own clustering) -- tests
  // below assert against 20016.
  const barsWithBothLevels = [...barsWithPivotLowNear(19990), ...barsWithPivotHighNear(20015)];

  it("targets the real resistance level ahead of price for a long, deriving the stop from its real distance", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice, atrValue: ATR, structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithBothLevels,
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("2.0"), // irrelevant here -- a used real level no longer falls back to this at all
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
    });
    expect(assessment.approved).toBe(true);
    expect(assessment.targetSrLevel?.type).toBe("resistance");
    expect(assessment.targetSrLevel?.price).toBeCloseTo(20016, 5);
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(20016, 5);
    // Derived stop = 16pt level distance / MIN_REWARD_RISK_RATIO(3) = 5.333pt
    // -- NOT the ~10pt ATR-based stop that would otherwise apply.
    expect(assessment.stopDistancePoints?.toNumber()).toBeCloseTo(16 / 3, 3);
    expect(assessment.reason).toContain("take-profit targets the nearest real resistance level");
  });

  // 2026-08-11's original concern (real NQ shorts, trades #359-362: target
  // distance shrank to 0.71pt against an unchanged ~5pt stop, R:R 0.14,
  // "cleared" for $2-7) doesn't reproduce under the current design: since the
  // stop is now derived FROM the level's own distance rather than checked
  // against an independent one, the ratio is exactly 3:1 by construction no
  // matter how close the level is -- a close level just derives a
  // proportionally tighter stop, not a degenerate reward:risk.
  it("still uses a real level close to entry, deriving a proportionally tight stop rather than rejecting or falling back", () => {
    const engine = new RiskEngine();
    // Resistance at 20001 is a real, 2-touch level, only 1pt from entry.
    const tooCloseBars = [...barsWithPivotLowNear(19990), ...barsWithPivotHighNear(20001)];
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice, atrValue: ATR, structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: tooCloseBars,
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("3.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
    });
    expect(assessment.approved).toBe(true);
    expect(assessment.targetSrLevel?.price).toBeCloseTo(20001, 5);
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(20001, 5);
    expect(assessment.stopDistancePoints?.toNumber()).toBeCloseTo(1 / 3, 3); // 1pt / 3, not the ~10pt ATR stop
  });

  it("a strategy-provided explicit take-profit still wins over the S/R-derived target, with the stop derived from IT instead", () => {
    const engine = new RiskEngine();
    const assessment = engine.assessNewTrade({
      side: "long", entryPrice, atrValue: ATR, structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits, pointValue: new Decimal(2), tickSize: new Decimal("0.25"), newsStatus: NO_NEWS,
      bars: barsWithBothLevels,
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("3.0"), // irrelevant -- explicitTakeProfitPrice drives the derivation instead
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
      // 12pt from entry -- distinct from the real S/R level's 20016, so a
      // pass here can only mean the explicit target genuinely won (the real
      // S/R lookup is skipped entirely once an explicit target is set --
      // see risk/engine.ts's targetLevel computation).
      explicitTakeProfitPrice: entryPrice.plus(12),
    });
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.plus(12).toNumber(), 5);
    expect(assessment.targetSrLevel).toBeNull();
    // Stop derived from the explicit 12pt target (tradePlan.ts's "target
    // explicit only" branch), not computeInitialStop's own ATR-based stop.
    expect(assessment.stopDistancePoints?.toNumber()).toBeCloseTo(4, 3); // 12 / 3
  });
});

// 2026-09-01, operator request: "ES and NQ should never enter into
// conflicting trades" -- confirmed live, e.g. an open NQ long simultaneous
// with an open ES short (real trades #177/#178/#179). See
// engine/crossSymbolConflictCheck.ts and replay/types.ts's
// DecisionContext.hasConflictingPosition for how this boolean gets resolved
// for a real trade; this module only cares that the flag, once true, blocks
// unconditionally before anything else.
describe("RiskEngine.assessNewTrade -- ES/NQ cross-symbol conflict gate", () => {
  function assess(hasConflictingCrossSymbolPosition: boolean) {
    return new RiskEngine().assessNewTrade({
      side: "long",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "reversal",
      breakoutLevelPrice: null,
      accountState: accountState(),
      limits: BASE_LIMITS,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19990),
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("3.0"), // target = stop x 3 always clears MIN_REWARD_RISK_RATIO by construction -- this block doesn't care about the specific price
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
      hasConflictingCrossSymbolPosition,
    });
  }

  it("blocks the trade outright when a correlated instrument has an open position in the opposite direction", () => {
    const assessment = assess(true);
    expect(assessment.approved).toBe(false);
    expect(assessment.quantity).toBe(0);
    expect(assessment.stopPrice).toBeNull();
    expect(assessment.takeProfitPrice).toBeNull();
    expect(assessment.reason).toContain("conflicting");
  });

  it("is otherwise a complete no-op -- an unrelated, non-conflicting setup still executes normally", () => {
    const assessment = assess(false);
    expect(assessment.approved).toBe(true);
    expect(assessment.quantity).toBeGreaterThan(0);
  });

  it("defaults to false (no block) when the param is omitted, so every pre-existing call site is unaffected", () => {
    const assessment = new RiskEngine().assessNewTrade({
      side: "long",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "reversal",
      breakoutLevelPrice: null,
      accountState: accountState(),
      limits: BASE_LIMITS,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19990),
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("3.0"), // target = stop x 3 always clears MIN_REWARD_RISK_RATIO by construction -- this test doesn't care about the specific price
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
    });
    expect(assessment.approved).toBe(true);
  });
});
