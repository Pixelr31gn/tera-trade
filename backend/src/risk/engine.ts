/**
 * Risk engine: the single gate every candidate trade must pass through.
 *
 * Order of checks (fail fast, cheapest/most-important first):
 * 1. Circuit breakers (daily loss, trailing drawdown, consecutive losses, daily trade cap)
 * 2. News-event risk window
 * 3. Stop-loss plan (structure vs ATR) -- no valid stop, no trade
 * 4. Position sizing from the stop distance -- if it sizes to zero contracts, no trade
 */
import { Decimal } from "decimal.js";
import type { NewsRiskStatus } from "../news/risk.js";
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
}

export class RiskEngine {
  assessNewTrade(params: {
    side: "long" | "short";
    entryPrice: Decimal;
    atrValue: Decimal;
    structureSwingPrice: Decimal | null;
    accountState: AccountRiskState;
    limits: RiskLimitsConfig;
    pointValue: Decimal;
    tickSize: Decimal;
    newsStatus: NewsRiskStatus;
  }): RiskAssessment {
    const { side, entryPrice, atrValue, structureSwingPrice, accountState, limits, pointValue, tickSize, newsStatus } = params;

    const breaker = checkCircuitBreakers(accountState, limits);
    if (!breaker.allowed) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: breaker.reason ?? "circuit breaker tripped", tripKillSwitch: breaker.tripKillSwitch,
      };
    }

    if (newsStatus.inRiskWindow) {
      const minutes = newsStatus.minutesToEvent;
      const when = minutes !== null && minutes > 0 ? `in ${minutes.toFixed(0)} min` : `${Math.abs(minutes ?? 0).toFixed(0)} min ago`;
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: `blocked by news risk window: '${newsStatus.nearestEventName}' (${newsStatus.impact} impact) ${when}`,
        tripKillSwitch: false,
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
    };
  }
}
