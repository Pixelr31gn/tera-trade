/**
 * Shared stop/target/sizing computation -- used by both the real execution
 * path (risk/engine.ts's assessNewTrade) and the recommendation-preview
 * endpoints (api/routes/scores.ts), so a setup shown on the dashboard always
 * reflects the exact stop/target/quantity that would actually be traded,
 * not a separate, stale approximation.
 */
import { Decimal } from "decimal.js";
import { computePositionSize } from "./sizing.js";
import { computeInitialStop } from "./stops.js";

export interface TradePlan {
  stopPrice: Decimal;
  takeProfitPrice: Decimal;
  stopDistancePoints: Decimal;
  trailTicks: number;
  quantity: number;
  sizingReason: string;
}

// Minimum risk:reward floor -- risk must be at least 1/3 of the target
// reward (risking $1 to make $3, at minimum), or the stop is too tight
// relative to what the trade is aiming to make and gets hit by ordinary
// price noise long before price could ever reach the target. This showed up
// concretely with a near-zero ATR (effectively zero-range price ticks
// feeding the stop calculation) producing stops of a few dollars against
// $130+ targets -- nominally a great R:R on paper, but the stop was too
// tight to survive normal noise. Only meaningful for a fixed-dollar profit
// target: the R:R-multiple fallback (no fixed target configured) already
// derives its target *from* the stop at a fixed 2:1, which always clears
// this floor by construction.
const MIN_RISK_REWARD_DENOMINATOR = 3;

export function computeTradePlan(params: {
  side: "long" | "short";
  entryPrice: Decimal;
  atrValue: Decimal;
  structureSwingPrice: Decimal | null;
  tickSize: Decimal;
  pointValue: Decimal;
  riskAmount: Decimal;
  profitDollars: Decimal | null;
  maxPositionSize: number;
}): TradePlan {
  const { side, entryPrice, atrValue, structureSwingPrice, tickSize, pointValue, riskAmount, profitDollars, maxPositionSize } = params;

  const stopPlan = computeInitialStop(entryPrice, side, atrValue, structureSwingPrice, { tickSize });
  const sizing = computePositionSize(riskAmount, stopPlan.stopDistancePoints, pointValue, maxPositionSize);

  let stopPrice = stopPlan.stopPrice;
  let stopDistancePoints = stopPlan.stopDistancePoints;
  let sizingReason = sizing.reason;

  // A fixed-dollar profit target must reflect the actual sized quantity
  // (points needed = dollars / (pointValue * quantity)), so it can only be
  // computed once sizing is known -- overrides the stop plan's default
  // R:R-multiple-based target when configured.
  let takeProfitPrice = stopPlan.takeProfitPrice;
  if (profitDollars != null && sizing.quantity > 0) {
    const profitDistance = profitDollars.dividedBy(pointValue.times(sizing.quantity));
    takeProfitPrice = side === "long" ? entryPrice.plus(profitDistance) : entryPrice.minus(profitDistance);

    const actualRiskDollars = stopDistancePoints.times(pointValue).times(sizing.quantity);
    const minRiskDollars = profitDollars.dividedBy(MIN_RISK_REWARD_DENOMINATOR);
    if (actualRiskDollars.lt(minRiskDollars)) {
      const minStopDistance = minRiskDollars.dividedBy(pointValue.times(sizing.quantity));
      stopDistancePoints = minStopDistance;
      stopPrice = side === "long" ? entryPrice.minus(minStopDistance) : entryPrice.plus(minStopDistance);
      sizingReason = `${sizingReason}; stop widened to ${minStopDistance.toFixed(4)} pts to keep risk at/above 1/${MIN_RISK_REWARD_DENOMINATOR} of the $${profitDollars.toFixed(2)} target (was $${actualRiskDollars.toFixed(2)}, floor is $${minRiskDollars.toFixed(2)})`;
    }
  }

  return {
    stopPrice,
    takeProfitPrice,
    stopDistancePoints,
    trailTicks: stopPlan.trailTicks,
    quantity: sizing.quantity,
    sizingReason,
  };
}
