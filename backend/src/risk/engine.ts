/**
 * Risk engine: the single gate every candidate trade must pass through.
 *
 * Order of checks (fail fast, cheapest/most-important first):
 * 1. Circuit breakers (daily loss, trailing drawdown, consecutive losses, daily trade cap)
 * 2. Support/resistance proximity -- entries are only taken close to a real
 *    swing-pivot level, never mid-air (see analytics/supportResistance.ts)
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
// far from any real pivot.
const MAX_ENTRY_DISTANCE_ATR = 1.0;

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
  }): RiskAssessment {
    const { side, entryPrice, atrValue, structureSwingPrice, signalKind, breakoutLevelPrice, accountState, limits, pointValue, tickSize, bars } = params;

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
    if (nearest.distanceInAtr > MAX_ENTRY_DISTANCE_ATR) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason:
          signalKind === "breakout"
            ? `entry is ${nearest.distanceInAtr.toFixed(2)}x ATR past the broken level (${nearest.level.price.toFixed(2)}, ${nearest.level.touches} touches) -- too extended, needs to be within ${MAX_ENTRY_DISTANCE_ATR}x ATR`
            : `entry is ${nearest.distanceInAtr.toFixed(2)}x ATR from the nearest ${nearest.level.type} level (${nearest.level.price.toFixed(2)}, ${nearest.level.touches} touches) -- needs to be within ${MAX_ENTRY_DISTANCE_ATR}x ATR`,
        tripKillSwitch: false, nearestSrLevel: nearest.level,
      };
    }

    // Fixed-dollar risk overrides percentage-of-equity when configured, so
    // the risk budget stays constant regardless of intraday equity swings.
    const riskAmount = limits.perTradeRiskDollars ?? accountState.currentEquity.times(limits.perTradeRiskPct).dividedBy(100);

    const plan = computeTradePlan({
      side, entryPrice, atrValue, structureSwingPrice, tickSize, pointValue,
      riskAmount, profitDollars: limits.perTradeProfitDollars ?? null, maxPositionSize: limits.maxPositionSize,
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
