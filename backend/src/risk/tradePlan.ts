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

  // A fixed-dollar profit target must reflect the actual sized quantity
  // (points needed = dollars / (pointValue * quantity)), so it can only be
  // computed once sizing is known -- overrides the stop plan's default
  // R:R-multiple-based target when configured.
  let takeProfitPrice = stopPlan.takeProfitPrice;
  if (profitDollars != null && sizing.quantity > 0) {
    const profitDistance = profitDollars.dividedBy(pointValue.times(sizing.quantity));
    takeProfitPrice = side === "long" ? entryPrice.plus(profitDistance) : entryPrice.minus(profitDistance);
  }

  return {
    stopPrice: stopPlan.stopPrice,
    takeProfitPrice,
    stopDistancePoints: stopPlan.stopDistancePoints,
    trailTicks: stopPlan.trailTicks,
    quantity: sizing.quantity,
    sizingReason: sizing.reason,
  };
}
