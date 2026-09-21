import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { RiskEngine, evaluateDailyPlanRange, type DailyPlanZone } from "../src/risk/engine.js";
import { DEFAULT_CONFIDENCE_TIERS } from "../src/risk/sizing.js";
import type { AccountRiskState, RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { NewsRiskStatus } from "../src/news/risk.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const NO_NEWS: NewsRiskStatus = { inRiskWindow: false, nearestEventName: null, nearestEventTime: null, minutesToEvent: null, impact: null };
const TICK = new Decimal("0.25");

function barsWithPivotLowNear(price: number): OhlcBar[] {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  const dip = (blockStart: number) =>
    Array.from({ length: 9 }, (_, i) => {
      const low = price + Math.abs(i - 4) * 2;
      const high = low + 3 + blockStart + i;
      return { time: new Date(base + (blockStart + i) * 60_000), open: low + 1, high, low, close: low + 1, volume: 100 };
    });
  return [...dip(0), ...dip(9)];
}

function accountState(): AccountRiskState {
  return { currentEquity: new Decimal(50000), peakEquity: new Decimal(50000), dailyStartingEquity: new Decimal(50000), consecutiveLosses: 0, tradesToday: 0 };
}

const BASE_LIMITS: RiskLimitsConfig = {
  perTradeRiskPct: new Decimal("0.5"),
  maxDailyLossPct: new Decimal("3"),
  maxTrailingDrawdownPct: new Decimal("6"),
  maxConsecutiveLosses: 3,
  maxDailyTrades: 13,
  maxPositionSize: 10,
};

// Support boundary 19980-19990, resistance boundary 20010-20020 -- symmetric
// around the ENTRY_PRICE=20000 default so individual tests can move entryPrice
// into either zone, past either boundary, or leave it strictly mid-range.
const SUPPORT: DailyPlanZone = { priceLow: new Decimal(19980), priceHigh: new Decimal(19990), enforcement: "hard", label: "support boundary" };
const RESISTANCE: DailyPlanZone = { priceLow: new Decimal(20010), priceHigh: new Decimal(20020), enforcement: "hard", label: "resistance boundary" };
const RANGE_ZONES: DailyPlanZone[] = [SUPPORT, RESISTANCE];

function assess(side: "long" | "short", entryPrice: Decimal, dailyPlanZones?: DailyPlanZone[], requiresDailyPlan?: boolean) {
  return new RiskEngine().assessNewTrade({
    side,
    entryPrice,
    atrValue: new Decimal(6.667),
    structureSwingPrice: null,
    signalKind: "reversal",
    breakoutLevelPrice: null,
    accountState: accountState(),
    limits: BASE_LIMITS,
    pointValue: new Decimal(2),
    tickSize: TICK,
    newsStatus: NO_NEWS,
    bars: barsWithPivotLowNear(19990),
    averageProbability: 0.75, // 75%+ tier -> 2 contracts (DEFAULT_CONFIDENCE_TIERS)
    // 3.0 (target = stop x 3, always exactly in ratio -- 2026-09-08, see
    // stops.ts's MIN_REWARD_RISK_RATIO) -- the non-fade-mode tests below (no
    // zones, or a breakout past the range) rely on this generic multiple.
    // Fade-mode trades (this block's own explicit stop/target, anchored to
    // the real range boundaries) are unaffected by this value either way --
    // see the describe block below.
    takeProfitRMultiple: new Decimal("3.0"),
    confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
    // Isolates these tests to the daily-plan-range gate specifically -- the
    // S/R existence/distance gate is covered by riskEngine.test.ts, and its
    // own pivot-touch requirements would otherwise constrain which
    // entryPrice values these tests could use.
    srGateBypass: true,
    dailyPlanZones,
    requiresDailyPlan,
  });
}

describe("evaluateDailyPlanRange", () => {
  it("is a no-op with no zones, one zone, or more than two zones", () => {
    const entry = new Decimal(20000);
    expect(evaluateDailyPlanRange(entry, "long", TICK, []).mode).toBe("none");
    expect(evaluateDailyPlanRange(entry, "long", TICK, [SUPPORT]).mode).toBe("none");
    expect(evaluateDailyPlanRange(entry, "long", TICK, [SUPPORT, RESISTANCE, { priceLow: new Decimal(19000), priceHigh: new Decimal(19010), enforcement: "hard", label: "stray" }]).mode).toBe(
      "none"
    );
  });

  it("is unrestricted strictly between the two boundaries", () => {
    const result = evaluateDailyPlanRange(new Decimal(20000), "long", TICK, RANGE_ZONES);
    expect(result.mode).toBe("none");
  });

  it("allows a short fading unbroken resistance, with stop above it and target toward support", () => {
    const result = evaluateDailyPlanRange(new Decimal(20015), "short", TICK, RANGE_ZONES);
    expect(result.mode).toBe("fade");
    expect(result.stopPrice?.toNumber()).toBeGreaterThan(20020);
    expect(result.takeProfitPrice?.toNumber()).toBeLessThanOrEqual(19990);
  });

  it("blocks a long testing unbroken resistance", () => {
    const result = evaluateDailyPlanRange(new Decimal(20015), "long", TICK, RANGE_ZONES);
    expect(result.mode).toBe("blocked");
    expect(result.reason).toContain("resistance boundary");
  });

  it("allows a long fading unbroken support, with stop below it and target toward resistance", () => {
    const result = evaluateDailyPlanRange(new Decimal(19985), "long", TICK, RANGE_ZONES);
    expect(result.mode).toBe("fade");
    expect(result.stopPrice?.toNumber()).toBeLessThan(19980);
    expect(result.takeProfitPrice?.toNumber()).toBeGreaterThanOrEqual(20010);
  });

  it("blocks a short testing unbroken support", () => {
    const result = evaluateDailyPlanRange(new Decimal(19985), "short", TICK, RANGE_ZONES);
    expect(result.mode).toBe("blocked");
    expect(result.reason).toContain("support boundary");
  });

  it("allows a long confirming a break above resistance", () => {
    const result = evaluateDailyPlanRange(new Decimal(20025), "long", TICK, RANGE_ZONES);
    expect(result.mode).toBe("breakout");
  });

  it("blocks a short fighting a confirmed break above resistance", () => {
    const result = evaluateDailyPlanRange(new Decimal(20025), "short", TICK, RANGE_ZONES);
    expect(result.mode).toBe("blocked");
  });

  it("allows a short confirming a break below support", () => {
    const result = evaluateDailyPlanRange(new Decimal(19975), "short", TICK, RANGE_ZONES);
    expect(result.mode).toBe("breakout");
  });

  it("blocks a long fighting a confirmed break below support", () => {
    const result = evaluateDailyPlanRange(new Decimal(19975), "long", TICK, RANGE_ZONES);
    expect(result.mode).toBe("blocked");
  });
});

describe("RiskEngine.assessNewTrade -- daily plan range gate", () => {
  it("is a complete no-op when no zones are set for this symbol today", () => {
    const withZones = assess("long", new Decimal(20000), []);
    const withoutZones = assess("long", new Decimal(20000), undefined);
    expect(withZones.approved).toBe(true);
    expect(withoutZones.approved).toBe(true);
    expect(withZones.quantity).toBe(withoutZones.quantity);
  });

  it("rejects a long testing unbroken resistance", () => {
    const assessment = assess("long", new Decimal(20015), RANGE_ZONES);
    expect(assessment.approved).toBe(false);
    expect(assessment.quantity).toBe(0);
    expect(assessment.reason).toContain("daily plan range");
  });

  it("approves a short fading resistance at full confidence-tier size, with stop/target anchored to the real range boundaries, not derived from each other", () => {
    const assessment = assess("short", new Decimal(20015), RANGE_ZONES);
    expect(assessment.approved).toBe(true);
    expect(assessment.quantity).toBe(2); // 75%+ tier, unaffected by the fade (no size penalty in the new model)
    // Stop beyond the resistance zone (20020) -- a real, independent price,
    // not derived from the target (fade mode sets both explicit -- see
    // tradePlan.ts's "both explicit" branch).
    expect(assessment.stopPrice?.toNumber()).toBeGreaterThan(20020);
    // Target at/through the support zone's near edge (19990) -- also real
    // and independent, ~25pts from entry.
    expect(assessment.takeProfitPrice?.toNumber()).toBeLessThanOrEqual(19990);
  });

  it("approves a long fading support at full confidence-tier size, with stop/target anchored to the real range boundaries, not derived from each other", () => {
    const assessment = assess("long", new Decimal(19985), RANGE_ZONES);
    expect(assessment.approved).toBe(true);
    expect(assessment.quantity).toBe(2);
    expect(assessment.stopPrice?.toNumber()).toBeLessThan(19980);
    expect(assessment.takeProfitPrice?.toNumber()).toBeGreaterThanOrEqual(20010);
  });

  it("approves a breakout trade with normal ATR-based stop/target, not a level-anchored one", () => {
    const assessment = assess("long", new Decimal(20025), RANGE_ZONES);
    expect(assessment.approved).toBe(true);
    // Normal ATR-based stop (atrValue 6.667 x 1.5 multiplier, no cap as of
    // 2026-09-08) -- nowhere near the far side of the range the way a
    // fade's stop would be.
    expect(assessment.stopDistancePoints?.toNumber()).toBeCloseTo(6.667 * 1.5, 2);
  });
});

// 2026-09-08, operator request ("i dont want any trades taken for gc unless
// it has a daily trading plan") -- requiresDailyPlan inverts the normal
// fail-open default (see risk/stops.ts's REQUIRE_DAILY_PLAN_SYMBOLS) for a
// symbol-scoped subset of trades. Entry stays strictly mid-range (20000,
// dailyPlanRange.mode "none" with zones present) so these tests isolate this
// one flag rather than the fade/blocked/breakout classification above.
describe("RiskEngine.assessNewTrade -- requiresDailyPlan", () => {
  it("rejects when no zones are set at all and requiresDailyPlan is true", () => {
    const assessment = assess("long", new Decimal(20000), undefined, true);
    expect(assessment.approved).toBe(false);
    expect(assessment.quantity).toBe(0);
    expect(assessment.reason).toContain("requires a daily-plan range");
  });

  it("rejects when zones exist but don't resolve to a valid range (mode 'none') and requiresDailyPlan is true", () => {
    const assessment = assess("long", new Decimal(20000), [SUPPORT], true); // one zone -- degenerate, same as none
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain("requires a daily-plan range");
  });

  it("approves normally once a valid range exists, even with requiresDailyPlan true", () => {
    const assessment = assess("long", new Decimal(20000), RANGE_ZONES, true); // strictly mid-range = mode "none", but zones ARE valid/set
    expect(assessment.approved).toBe(true);
  });

  it("still blocks/fades normally when a valid range exists and price is testing a boundary, requiresDailyPlan true", () => {
    const blocked = assess("long", new Decimal(20015), RANGE_ZONES, true);
    expect(blocked.approved).toBe(false);
    expect(blocked.reason).toContain("daily plan range:");
    expect(blocked.reason).not.toContain("requires a daily-plan range"); // the ordinary "blocked" reason, not the requiresDailyPlan one

    const fade = assess("short", new Decimal(20015), RANGE_ZONES, true);
    expect(fade.approved).toBe(true);
  });

  it("defaults to false -- no zones and requiresDailyPlan omitted still approves normally (the existing fail-open behavior, unaffected)", () => {
    const assessment = assess("long", new Decimal(20000), undefined);
    expect(assessment.approved).toBe(true);
  });
});

// 2026-09-09, operator instruction ("the stop loss is supposed to be set
// based on the tp not where the daily-plan resistance boundary sits ... sl
// need to be adjusted based on 1/3rd of how many points the tp is set to")
// -- the hardTakeProfitDollars override path's stop is now always derived
// from the take-profit distance (1/MIN_REWARD_RISK_RATIO of it), never
// anchored to the daily-plan zone boundary (the previous 2026-08-31 design,
// retired the same day this changed after it blocked a fully-agreeing
// v1/v2/v3/v7 NQ short at a 76.25pt zone-anchored stop). Entry stays at the
// default 20000 (strictly mid-range between SUPPORT/RESISTANCE), since this
// branch's own stop logic -- not the daily-plan-range gate's own
// blocked/fade/breakout classification -- is what's under test here.
describe("RiskEngine.assessNewTrade -- hardTakeProfitDollars stop is derived from the take-profit distance", () => {
  function assessHardTarget(side: "long" | "short", dailyPlanZones?: DailyPlanZone[], assistantTakeProfitCapPoints?: Decimal | null) {
    return new RiskEngine().assessNewTrade({
      side,
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "reversal",
      breakoutLevelPrice: null,
      accountState: accountState(),
      limits: BASE_LIMITS,
      pointValue: new Decimal(2),
      tickSize: TICK,
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19990),
      averageProbability: 0.75,
      // Unused by this branch as of 2026-09-09 -- take-profit is no longer
      // derived from stopDistance x takeProfitRMultiple here (see the
      // describe block's own comment). Left at an arbitrary value only
      // because assessNewTrade's params require one.
      takeProfitRMultiple: new Decimal("4.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
      srGateBypass: true,
      hardTakeProfitDollars: 5,
      assistantTakeProfitCapPoints,
      dailyPlanZones,
    });
  }

  // 2026-09-21, operator instruction stated as an absolute: "the risk has to
  // be smaller than what we are trying to win at all times no exceptions."
  // This branch is now entered ONLY when a real per-session likely-move read
  // exists. Without one there is nothing honest to size a target from, so the
  // trade falls through to the ordinary ATR/structure/swing pipeline instead
  // of pairing a placeholder target with either a 1.75pt stop or a 100pt
  // sentinel. See risk/engine.ts's comment on the branch condition for both
  // real failures that motivated this.
  it("no longer pairs a sentinel stop with a flat target when no likely-move read exists -- falls through to the real pipeline", () => {
    const assessment = assessHardTarget("long", undefined);
    expect(assessment.approved).toBe(true);
    // The retired path produced exactly 100pt of risk against a 5pt target.
    expect(assessment.stopDistancePoints!.toNumber()).not.toBe(100);
    expect(assessment.takeProfitPrice!.minus(20000).abs().toNumber()).not.toBeCloseTo(5, 1);
    expect(assessment.reason).not.toContain("no real stop-loss");
    const risk = new Decimal(20000).minus(assessment.stopPrice!).abs();
    const reward = assessment.takeProfitPrice!.minus(20000).abs();
    expect(reward.gt(risk)).toBe(true);
  });

  it("a long's stop is derived from 1/3 of the take-profit distance, not the support boundary", () => {
    const assessment = assessHardTarget("long", RANGE_ZONES, new Decimal(60));
    expect(assessment.approved).toBe(true);
    expect(assessment.takeProfitPrice!.minus(20000).abs().toNumber()).toBeCloseTo(60, 1);
    expect(assessment.stopDistancePoints!.toNumber()).toBeCloseTo(20, 1);
    expect(assessment.stopPrice?.toNumber()).toBeGreaterThan(19970);
    expect(assessment.reason).toContain("stop derived at 1/3 of that distance");
  });

  it("a short's stop is derived from 1/3 of the take-profit distance, not the resistance boundary", () => {
    const assessment = assessHardTarget("short", RANGE_ZONES, new Decimal(60));
    expect(assessment.approved).toBe(true);
    expect(assessment.takeProfitPrice!.minus(20000).abs().toNumber()).toBeCloseTo(60, 1);
    expect(assessment.stopDistancePoints!.toNumber()).toBeCloseTo(20, 1);
    expect(assessment.stopPrice?.toNumber()).toBeLessThan(20030);
    expect(assessment.reason).toContain("stop derived at 1/3 of that distance");
  });

  // The zones only ever gated WHICH trades may run, never how far the stop
  // sat, so their absence must not change the stop/target relationship. It
  // used to: no range meant the sentinel/flat pairing instead.
  it("uses the same target/3 geometry whether or not a daily-plan range exists", () => {
    const cap = new Decimal(60);
    const withRange = assessHardTarget("long", RANGE_ZONES, cap);
    const withoutRange = assessHardTarget("long", undefined, cap);
    expect(withoutRange.approved).toBe(true);
    expect(withoutRange.takeProfitPrice!.toNumber()).toBe(withRange.takeProfitPrice!.toNumber());
    expect(withoutRange.stopDistancePoints!.toNumber()).toBeCloseTo(withRange.stopDistancePoints!.toNumber(), 4);
  });

  it("when the assistant has set a likely-move read this session, it becomes the take-profit target directly", () => {
    const assessment = assessHardTarget("long", RANGE_ZONES, new Decimal(70));
    expect(assessment.takeProfitPrice!.minus(20000).abs().toNumber()).toBeCloseTo(70, 1);
    expect(assessment.stopDistancePoints!.toNumber()).toBeCloseTo(70 / 3, 1);
    expect(assessment.reason).toContain("assistant's session likely-move read");
  });

  it("a looser assistant likely-move read also becomes the target directly", () => {
    const assessment = assessHardTarget("long", RANGE_ZONES, new Decimal(500));
    expect(assessment.approved).toBe(true);
    expect(assessment.takeProfitPrice!.minus(20000).abs().toNumber()).toBeCloseTo(500, 1);
    expect(assessment.stopDistancePoints!.toNumber()).toBeCloseTo(500 / 3, 1);
  });

  it("a null assistant cap behaves the same as no cap at all -- both leave this branch entirely", () => {
    const withUndefined = assessHardTarget("long", RANGE_ZONES, undefined);
    const withNull = assessHardTarget("long", RANGE_ZONES, null);
    expect(withNull.takeProfitPrice?.toNumber()).toBe(withUndefined.takeProfitPrice?.toNumber());
    expect(withNull.reason).not.toContain("likely-move read");
  });
});

// 2026-09-21: the standing invariant, tested through the public surface
// rather than against any one branch -- an approved trade must always stand
// to make more than it risks, and its stop/target must be on the correct
// sides of entry. Swept across both sides, a wide span of likely-move reads,
// and with/without a daily-plan range, because the two real violations this
// session each came from a DIFFERENT branch believing itself exempt from the
// ratio.
describe("RiskEngine.assessNewTrade -- every approved trade risks less than it stands to make", () => {
  const WIDE_SUPPORT: DailyPlanZone = { priceLow: new Decimal(19960), priceHigh: new Decimal(19970), enforcement: "hard", label: "wide support boundary" };
  const WIDE_RESISTANCE: DailyPlanZone = { priceLow: new Decimal(20030), priceHigh: new Decimal(20040), enforcement: "hard", label: "wide resistance boundary" };
  const WIDE_RANGE_ZONES: DailyPlanZone[] = [WIDE_SUPPORT, WIDE_RESISTANCE];

  function assess(side: "long" | "short", dailyPlanZones: DailyPlanZone[] | undefined, cap: Decimal | null) {
    return new RiskEngine().assessNewTrade({
      side,
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      signalKind: "reversal",
      breakoutLevelPrice: null,
      accountState: accountState(),
      limits: BASE_LIMITS,
      pointValue: new Decimal(2),
      tickSize: TICK,
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(19990),
      averageProbability: 0.75,
      takeProfitRMultiple: new Decimal("3.0"),
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
      srGateBypass: true,
      hardTakeProfitDollars: 5,
      assistantTakeProfitCapPoints: cap,
      dailyPlanZones,
    });
  }

  it("holds across sides, likely-move reads, and zone presence", () => {
    const entry = new Decimal(20000);
    let approvedCount = 0;
    for (const side of ["long", "short"] as const) {
      for (const zones of [undefined, WIDE_RANGE_ZONES]) {
        for (const capPoints of [null, 1, 2, 5, 12, 30, 60, 120, 500]) {
          const cap = capPoints === null ? null : new Decimal(capPoints);
          const a = assess(side, zones, cap);
          if (!a.approved) continue;
          approvedCount++;
          const risk = entry.minus(a.stopPrice!).abs();
          const reward = a.takeProfitPrice!.minus(entry).abs();
          const label = side + " cap=" + String(capPoints) + " zones=" + (zones ? "wide" : "none");
          if (side === "long") {
            expect(a.takeProfitPrice!.gt(entry), label).toBe(true);
            expect(a.stopPrice!.lt(entry), label).toBe(true);
          } else {
            expect(a.takeProfitPrice!.lt(entry), label).toBe(true);
            expect(a.stopPrice!.gt(entry), label).toBe(true);
          }
          expect(reward.gt(risk), label + ": risk " + risk.toString() + " vs reward " + reward.toString()).toBe(true);
        }
      }
    }
    // Guard against the sweep silently approving nothing and passing.
    expect(approvedCount).toBeGreaterThan(10);
  });
});
