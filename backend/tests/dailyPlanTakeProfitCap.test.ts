import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/engine.js";
import { MIN_REWARD_RISK_RATIO, takeProfitTickBandFor } from "../src/risk/stops.js";
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
      // 2026-11-12: this fixture is an NQ trade (30000, $2/pt), so it gets NQ's band (120-300 ticks).
      takeProfitTickBand: takeProfitTickBandFor("NQ"),
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
    // 2026-11-08: the 30-75 tick take-profit band (stops.ts's TAKE_PROFIT_MAX_TICKS) is applied last, and the 3:1 / reward>risk floors are off (risk/engine.ts's ENFORCE_REWARD_RISK_FLOOR, REWARD_MUST_EXCEED_RISK).
    // So the target lands on the band's 75-tick (18.75pt) maximum, not the cap.
    // 2026-11-12: NQ's band is 120-300 ticks (30-75pts), so the 73.33 cap fits inside it (73.50 after rounding).
    expect(reward.toNumber()).toBe(73.5);
    // Stop still re-derived at cap/3 -- NOT left at its original, larger distance.
    expect(risk.minus(cap.dividedBy(MIN_REWARD_RISK_RATIO)).abs().toNumber()).toBeLessThanOrEqual(0.25);
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
    // 2026-11-08: the 30-75 tick take-profit band (stops.ts's TAKE_PROFIT_MAX_TICKS) is applied last, and the 3:1 / reward>risk floors are off (risk/engine.ts's ENFORCE_REWARD_RISK_FLOOR, REWARD_MUST_EXCEED_RISK).
    // A 5pt cap is under the band's 30-tick (7.5pt) minimum, so the target is pushed out to it.
    // 2026-11-12: NQ's band minimum is 120 ticks (30pts), and the stop now follows the banded target (30/3).
    expect(reward.toNumber()).toBe(30);
    expect(risk.minus(reward.dividedBy(MIN_REWARD_RISK_RATIO)).abs().toNumber()).toBeLessThanOrEqual(0.25);
  });

  it("would have bounded live trade 121", () => {
    // Trade 121: NQ long, stop 160.50 and target 481.50 (exactly 3x) against a
    // session cap of 73.33. A wide ATR reproduces that shape of plan.
    const cap = new Decimal("73.33");
    const uncapped = assess("long", null, new Decimal(107));
    // 2026-11-08: the 30-75 tick take-profit band (stops.ts's TAKE_PROFIT_MAX_TICKS) is applied last, and the 3:1 / reward>risk floors are off (risk/engine.ts's ENFORCE_REWARD_RISK_FLOOR, REWARD_MUST_EXCEED_RISK).
    // The band alone already holds trade 121's 481.50pt target to 18.75pt.
    // 2026-11-12: with no cap, the ~160pt ATR stop now sits against a 75pt banded
    // target, and REWARD_MUST_EXCEED_RISK is back on -- so it is rejected outright.
    expect(uncapped.approved).toBe(false);
    expect(uncapped.reason).toContain("is not smaller than reward");

    const capped = assess("long", cap, new Decimal(107));
    const reward = capped.takeProfitPrice!.minus(30000).abs();
    const risk = new Decimal(30000).minus(capped.stopPrice!).abs();
    expect(reward.lte(cap.plus("0.25"))).toBe(true);
    expect(risk.lt(new Decimal("481.50"))).toBe(true); // stop tightened with the cap, nowhere near trade 121's
  });
});

// 2026-11-12, trade #602: NQ short, 5 MNQ, -$702.50. A 210.75pt likely-move
// read gave a 70.25pt stop while the target was banded to 18.75pt. The stop
// must follow the banded target, and NQ gets its own (wider) band.
describe("trade #602 -- stop follows the banded target", () => {
  it("never risks more than the banded target on the daily-plan branch", async () => {
    const { takeProfitTickBandFor: bandFor } = await import("../src/risk/stops.js");
    const entry = new Decimal("28401.5");
    const run = (band?: ReturnType<typeof bandFor>) => new RiskEngine().assessNewTrade({
      side: "short", entryPrice: entry, atrValue: new Decimal(60), structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
      accountState: accountState(), limits: BASE_LIMITS, pointValue: new Decimal(2), tickSize: TICK, newsStatus: NO_NEWS,
      bars: barsWithPivotLowNear(28300), averageProbability: 0.75, takeProfitRMultiple: MIN_REWARD_RISK_RATIO,
      confidenceTiers: DEFAULT_CONFIDENCE_TIERS, srGateBypass: true, hardTakeProfitDollars: 5,
      assistantTakeProfitCapPoints: new Decimal("210.75"), takeProfitTickBand: band,
    });
    for (const [band, expectedTarget] of [[undefined, 18.75], [bandFor("NQ"), 75]] as const) {
      const a = run(band);
      expect(a.approved).toBe(true);
      const reward = entry.minus(a.takeProfitPrice!).toNumber();
      const risk = a.stopPrice!.minus(entry).toNumber();
      expect(reward).toBe(expectedTarget);
      expect(risk).toBeLessThanOrEqual(reward / 3 + 0.25);
    }
  });
});
