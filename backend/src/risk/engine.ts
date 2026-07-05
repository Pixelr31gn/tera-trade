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
import { computePositionSize } from "./sizing.js";
import { computeInitialStop } from "./stops.js";

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

    const stopPlan = computeInitialStop(entryPrice, side, atrValue, structureSwingPrice, { tickSize });

    const sizing = computePositionSize(accountState.currentEquity, limits.perTradeRiskPct, stopPlan.stopDistancePoints, pointValue, limits.maxPositionSize);

    return {
      approved: sizing.quantity > 0,
      quantity: sizing.quantity,
      stopPrice: stopPlan.stopPrice,
      takeProfitPrice: stopPlan.takeProfitPrice,
      trailTicks: stopPlan.trailTicks,
      stopDistancePoints: stopPlan.stopDistancePoints,
      reason: sizing.reason,
      tripKillSwitch: false,
    };
  }
}
