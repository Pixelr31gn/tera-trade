/**
 * Risk engine: the single gate every candidate trade must pass through.
 *
 * Order of checks (fail fast, cheapest/most-important first):
 * 1. Circuit breakers (daily loss, trailing drawdown, consecutive losses, daily trade cap)
 * 2. Support/resistance validation -- a real, previously-touched level must
 *    exist nearby at all (see analytics/supportResistance.ts). The
 *    distance-from-that-level band (MAX/MIN_ENTRY_DISTANCE_ATR) is a
 *    separate sub-check and can be temporarily suspended via
 *    srProximityGateSuspended (2026-08-06, see that param's own comment) --
 *    the level-existence/touch-count requirement itself never is.
 * 3. Stop-loss plan (structure vs ATR) -- no valid stop, no trade
 * 4. Position sizing from the stop distance -- if it sizes to zero contracts, no trade
 *
 * The hard news-risk-window block that used to sit here (reject any trade
 * within N minutes of a high-impact event) has been removed -- news
 * proximity is meant to be predictive signal (how the market actually reacts
 * to a release), not a blanket blocker, so it no longer vetoes an
 * already-approved setup. newsStatus is still threaded through for scoring
 * to use (see scoring/ruleScorer.ts's newsRisk factor).
 */
import { Decimal } from "decimal.js";
import {
  computeSupportResistanceLevels,
  findLevelNearBreakout,
  findNearestRelevantLevel,
  MIN_LEVEL_TOUCHES,
  type SrLevel,
} from "../analytics/supportResistance.js";
import type { NewsRiskStatus } from "../news/risk.js";
import type { OhlcBar } from "../regime/indicators.js";
import { checkCircuitBreakers, type AccountRiskState, type RiskLimitsConfig } from "./circuitBreakers.js";
import { computeTradePlan } from "./tradePlan.js";

export interface RiskAssessment {
  approved: boolean;
  quantity: number;
  stopPrice: Decimal | null;
  takeProfitPrice: Decimal | null;
  trailTicks: number | null;
  stopDistancePoints: Decimal | null;
  reason: string;
  tripKillSwitch: boolean;
  nearestSrLevel: SrLevel | null;
}

// How close an entry must be to the nearest relevant support/resistance
// level, in ATR units, to be allowed at all -- "close as possible," made
// concrete. Hand-set (not fitted): 0.5 ATR is already the level-clustering
// tolerance (see supportResistance.ts), so 1.0 ATR gives a little room
// around a level's own footprint without allowing an entry chosen mid-air
// far from any real pivot. (2026-07-20: loosened 25%, 1.0 -> 1.25, after
// several strong-trend setups were getting rejected for running slightly
// past this on continuous-scan signals. 2026-07-22: loosened again, 1.25 ->
// 1.9, operator request, after a sustained strong-trend session blocked
// essentially every continuous-scan signal on both ES and NQ -- entries were
// running 6-9x ATR past the nearest level, well beyond what the 25% bump
// covered. 2026-07-27: loosened again, 1.9 -> 3.0, operator request, same
// pattern recurring -- entries still getting blocked at ~2.9x ATR during a
// strong trend. 2026-07-28: removed entirely, operator request, then
// reinstated the same day at the same 1.25x-3.0x band. 2026-07-29: tightened
// back, 3.0 -> 1.95, operator request. 2026-08-01: scoped to reversal signals
// only -- this ceiling was being applied identically to breakout signals,
// which invert the premise: a reversal that's run far from the level it was
// supposed to bounce off really is stale, but a breakout is *supposed* to
// run away from the level it broke, and "too extended" is exactly the
// conviction a breakout strategy is trying to catch. Concrete evidence: a
// real ES short breakout (v1/v2/v3 all agreed, 68-97% confidence) was
// rejected three times as the move strengthened -- 1.00x -> 2.05x -> 3.88x
// ATR past the broken level -- purely because this ceiling didn't
// distinguish breakout from reversal (see docs/BUILD_HISTORY.md's account of
// this incident). The touch-count validation and MIN_ENTRY_DISTANCE_ATR
// floor below still apply to breakouts; only this ceiling is now
// reversal-only.
const MAX_ENTRY_DISTANCE_ATR = 1.95;

// Floor for the same check, added alongside the 2026-07-27 ceiling bump --
// entries sitting too close to the level itself are rejected too, not just
// ones that have run too far past it. Together these carve out a
// 0.25x-1.95x ATR "sweet spot" band instead of a single one-sided ceiling.
// (2026-07-29: loosened 1.25 -> 0.25, operator request.)
const MIN_ENTRY_DISTANCE_ATR = 0.25;

export class RiskEngine {
  assessNewTrade(params: {
    side: "long" | "short";
    entryPrice: Decimal;
    atrValue: Decimal;
    structureSwingPrice: Decimal | null;
    signalKind: "breakout" | "reversal";
    breakoutLevelPrice: Decimal | null;
    accountState: AccountRiskState;
    limits: RiskLimitsConfig;
    pointValue: Decimal;
    tickSize: Decimal;
    newsStatus: NewsRiskStatus;
    bars: OhlcBar[];
    /** Cross-version consensus average probability (0-1) -- see risk/tradePlan.ts's computeTradePlan. */
    averageProbability: number;
    /** Operator-adjustable (SystemState, see execution/mode.ts's setTakeProfitRMultiple) -- see this param's use below for the value's own history. */
    takeProfitRMultiple: Decimal;
    /** Operator-adjustable (SystemState, see execution/mode.ts's setConfidenceTiers). */
    confidenceTiers: [minAverageProbability: number, quantity: number][];
    /** Strategy-provided explicit stop/target -- see strategy/types.ts's Signal.explicitStopPrice/explicitTakeProfitPrice and risk/tradePlan.ts's computeTradePlan for how this overrides the generic stop/target. */
    explicitStopPrice?: Decimal;
    explicitTakeProfitPrice?: Decimal;
    /**
     * 2026-08-06 (operator request, 24h-boxed): skips both the
     * MAX_ENTRY_DISTANCE_ATR ceiling and MIN_ENTRY_DISTANCE_ATR floor checks
     * below -- the S/R *validation* requirement (a real 2+-touch level must
     * still exist nearby at all, see MIN_LEVEL_TOUCHES above) is unchanged,
     * only the distance-from-it band is suspended. This module stays pure
     * (no Date/Date.now() in risk/, see CLAUDE.md) -- the expiry check
     * itself lives in the caller (engine/loop.ts's
     * isSrProximityGateSuspended), which passes the already-computed
     * boolean in here. Defaults to false so every existing call site
     * (including replay) is unaffected unless it explicitly opts in.
     */
    srProximityGateSuspended?: boolean;
  }): RiskAssessment {
    const { side, entryPrice, atrValue, structureSwingPrice, signalKind, breakoutLevelPrice, accountState, limits, pointValue, tickSize, bars, averageProbability, takeProfitRMultiple, confidenceTiers, explicitStopPrice, explicitTakeProfitPrice, srProximityGateSuspended = false } = params;

    const breaker = checkCircuitBreakers(accountState, limits);
    if (!breaker.allowed) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: breaker.reason ?? "circuit breaker tripped", tripKillSwitch: breaker.tripKillSwitch, nearestSrLevel: null,
      };
    }

    const levels = computeSupportResistanceLevels(bars, entryPrice.toNumber(), atrValue.toNumber());

    // Breakout signals must be validated against the specific level they
    // broke, not the nearest same-direction level to current price -- see
    // Signal.signalKind's comment. Reversal/bounce signals keep the original
    // "enter near a level in the trade's favor" check.
    const nearest =
      signalKind === "breakout" && breakoutLevelPrice !== null
        ? findLevelNearBreakout(levels, breakoutLevelPrice.toNumber(), entryPrice.toNumber(), atrValue.toNumber())
        : findNearestRelevantLevel(levels, side, entryPrice.toNumber(), atrValue.toNumber());

    if (!nearest) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason:
          signalKind === "breakout"
            ? "no historical level found near the breakout point -- can't confirm this was a real, previously-tested level"
            : `no ${side === "long" ? "support" : "resistance"} level found nearby -- entries are only taken close to a real swing-pivot level`,
        tripKillSwitch: false, nearestSrLevel: null,
      };
    }
    if (signalKind === "breakout" && nearest.level.touches < MIN_LEVEL_TOUCHES) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: `breakout level (${nearest.level.price.toFixed(2)}) was only touched ${nearest.level.touches} time(s) -- not a validated support/resistance zone, needs at least ${MIN_LEVEL_TOUCHES}`,
        tripKillSwitch: false, nearestSrLevel: nearest.level,
      };
    }
    // Reversal-only: see MAX_ENTRY_DISTANCE_ATR's 2026-08-01 comment. A
    // breakout running far past the level it broke is the strategy working,
    // not a reason to reject it -- only a reversal signal stales out this way.
    // Both this and the floor below are skippable via srProximityGateSuspended
    // (2026-08-06, see that param's comment) -- the level-existence/touch-count
    // checks above still ran and still apply either way.
    if (!srProximityGateSuspended) {
      if (signalKind === "reversal" && nearest.distanceInAtr > MAX_ENTRY_DISTANCE_ATR) {
        return {
          approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
          reason: `entry is ${nearest.distanceInAtr.toFixed(2)}x ATR from the nearest ${nearest.level.type} level (${nearest.level.price.toFixed(2)}, ${nearest.level.touches} touches) -- needs to be within ${MAX_ENTRY_DISTANCE_ATR}x ATR`,
          tripKillSwitch: false, nearestSrLevel: nearest.level,
        };
      }
      if (nearest.distanceInAtr < MIN_ENTRY_DISTANCE_ATR) {
        return {
          approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
          reason: `entry is only ${nearest.distanceInAtr.toFixed(2)}x ATR from the nearest ${nearest.level.type} level (${nearest.level.price.toFixed(2)}, ${nearest.level.touches} touches) -- too close, needs to be at least ${MIN_ENTRY_DISTANCE_ATR}x ATR away`,
          tripKillSwitch: false, nearestSrLevel: nearest.level,
        };
      }
    }

    // Fixed-dollar risk overrides percentage-of-equity when configured, so
    // the risk budget stays constant regardless of intraday equity swings.
    const riskAmount = limits.perTradeRiskDollars ?? accountState.currentEquity.times(limits.perTradeRiskPct).dividedBy(100);

    const plan = computeTradePlan({
      side, entryPrice, atrValue, structureSwingPrice, tickSize, pointValue,
      riskAmount, profitDollars: limits.perTradeProfitDollars ?? null, maxPositionSize: limits.maxPositionSize,
      averageProbability,
      // Was hardcoded 2:1 here (2026-07-29, operator request, effective the
      // same day v5 became a required gate on every real execution -- v5's
      // own backtested win rate, 28.1% as of that change, was measured
      // against stops.ts's 3:1 default, an easier target to miss than 2:1;
      // that number does NOT directly carry over to real 2:1 performance,
      // breakeven moves from ~25% to ~33.3%, so re-validate once enough
      // real/simulated-at-2:1 outcomes accumulate rather than assuming the
      // same edge holds). 2026-08-02: made operator-adjustable at runtime
      // instead (SystemState.takeProfitRMultiple) -- 2:1 remains the
      // seeded default (see the migration), so nothing changes until the
      // operator deliberately moves it.
      takeProfitRMultiple,
      confidenceTiers,
      explicitStopPrice,
      explicitTakeProfitPrice,
    });

    return {
      approved: plan.quantity > 0,
      quantity: plan.quantity,
      stopPrice: plan.stopPrice,
      takeProfitPrice: plan.takeProfitPrice,
      trailTicks: plan.trailTicks,
      stopDistancePoints: plan.stopDistancePoints,
      reason: plan.sizingReason,
      tripKillSwitch: false,
      nearestSrLevel: nearest.level,
    };
  }
}
