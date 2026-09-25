import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/engine.js";
import { MIN_REWARD_RISK_RATIO } from "../src/risk/stops.js";
import { DEFAULT_CONFIDENCE_TIERS } from "../src/risk/sizing.js";
import type { AccountRiskState, RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { NewsRiskStatus } from "../src/news/risk.js";
import type { OhlcBar } from "../src/regime/indicators.js";

// Fixtures mirror tests/dailyPlanZones.test.ts. Duplicated rather than
// extracted into a shared helper: this file needs a different entry price and
// a wider ATR, and pulling a shared module out of an existing test file is
// churn nobody asked for.
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

/**
 * 2026-09-25, operator report: "still exceeding the tp point cap."
 *
 * assistantTakeProfitCapPoints -- DAILY_PLAN_TAKE_PROFIT_FRACTION of the
 * assistant's session likely-move read -- had only ever been read inside
 * risk/engine.ts's hardTakeProfitDollars branch, and that branch is skipped for
 * every real strategy signal (replay/decisionCore.ts passed the static
 * HARD_TAKE_PROFIT_DOLLARS constant and no cap at all). So the ceiling
 * constrained almost nothing. Live trade 121 took a 481.50pt target -- exactly
 * 3x a 160.50pt stop, via the generic R-multiple path -- against a 73.33pt cap.
 *
 * The cap is now applied to whatever the branch ends up with from ANY source,
 * with the stop RE-DERIVED from the capped target. That second half is the part
 * worth pinning: capping the target while leaving the original stop would risk
 * more than the reward, which is the inversion ruled out absolutely on
 * 2026-09-21.
 */
describe("daily-plan take-profit cap", () => {
  /** Generic R-multiple path: hardTakeProfitDollars undefined, so the branch above it is skipped. */
  function assess(side: "long" | "short", cap: Decimal | null, atr = new Decimal(20)) {
    return new RiskEngine().assessNewTrade({
      side,
      entryPrice: new Decimal(30000),
      atrValue: atr,
      structureSwingPrice: null,
      signalKind: "reversal",
      breakoutLevelPrice: null,
      accountState: accountState(),
      limits: BASE_LIMITS,
      pointValue: new Decimal(2),
      tickSize: TICK,
      newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(29990),
      averageProbability: 0.75,
      takeProfitRMultiple: MIN_REWARD_RISK_RATIO,
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
      srGateBypass: true,
      hardTakeProfitDollars: undefined,
      assistantTakeProfitCapPoints: cap,
    });
  }

  it("leaves a target that is already inside the cap alone", () => {
    const generous = assess("long", new Decimal(10_000));
    const uncapped = assess("long", null);
    expect(generous.approved).toBe(true);
    expect(generous.takeProfitPrice!.toString()).toBe(uncapped.takeProfitPrice!.toString());
    expect(generous.stopPrice!.toString()).toBe(uncapped.stopPrice!.toString());
    expect(generous.reason).not.toContain("capped at");
  });

  it("applies no ceiling at all when the assistant has set nothing this session", () => {
    const uncapped = assess("long", null);
    expect(uncapped.approved).toBe(true);
    // Fail-open: a null cap must not be treated as zero.
    expect(uncapped.takeProfitPrice!.minus(30000).toNumber()).toBeGreaterThan(0);
    expect(uncapped.reason).not.toContain("capped at");
  });

  it("caps an over-large target AND re-derives the stop, keeping 3:1", () => {
    const cap = new Decimal("73.33");
    const capped = assess("long", cap);
    expect(capped.approved).toBe(true);

    const reward = capped.takeProfitPrice!.minus(30000).abs();
    const risk = new Decimal(30000).minus(capped.stopPrice!).abs();
    // Target pulled down to the cap (a tick of rounding away from entry).
    expect(reward.minus(cap).abs().toNumber()).toBeLessThanOrEqual(0.25);
    // Stop re-derived at cap/3 -- NOT left at its original, larger distance.
    expect(risk.minus(cap.dividedBy(MIN_REWARD_RISK_RATIO)).abs().toNumber()).toBeLessThanOrEqual(0.25);
    // The invariant that makes re-deriving mandatory rather than optional.
    expect(reward.gt(risk)).toBe(true);
    expect(capped.reason).toContain("capped at the assistant's session likely-move read");
  });

  it("caps a short the same way, on the correct side of entry", () => {
    // A short's uncapped target here comes from the S/R level override, not the
    // R-multiple: findNearestTargetLevel picks the nearest support BELOW entry,
    // which these bars put ~10pts away. So the cap has to be tighter than that
    // to be the thing under test -- 60 would simply never bind on this fixture.
    const cap = new Decimal(5);
    const capped = assess("short", cap);
    expect(capped.approved).toBe(true);
    expect(capped.takeProfitPrice!.lt(new Decimal(30000))).toBe(true);
    expect(capped.stopPrice!.gt(new Decimal(30000))).toBe(true);

    const reward = new Decimal(30000).minus(capped.takeProfitPrice!);
    const risk = capped.stopPrice!.minus(new Decimal(30000));
    expect(reward.minus(cap).abs().toNumber()).toBeLessThanOrEqual(0.25);
    expect(risk.minus(cap.dividedBy(MIN_REWARD_RISK_RATIO)).abs().toNumber()).toBeLessThanOrEqual(0.25);
    expect(reward.gt(risk)).toBe(true);
  });

  it("would have bounded live trade 121", () => {
    // Trade 121: NQ long, stop 160.50 and target 481.50 (exactly 3x) against a
    // session cap of 73.33. A wide ATR reproduces that shape of plan.
    const cap = new Decimal("73.33");
    const uncapped = assess("long", null, new Decimal(107));
    const rewardUncapped = uncapped.takeProfitPrice!.minus(30000).abs();
    expect(rewardUncapped.gt(cap)).toBe(true); // the situation being fixed

    const capped = assess("long", cap, new Decimal(107));
    const reward = capped.takeProfitPrice!.minus(30000).abs();
    const risk = new Decimal(30000).minus(capped.stopPrice!).abs();
    expect(reward.lte(cap.plus("0.25"))).toBe(true);
    expect(risk.lt(rewardUncapped)).toBe(true); // stop tightened with the target
    expect(reward.gt(risk)).toBe(true);
  });
});
