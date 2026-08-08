/**
 * Shared stop/target/sizing computation -- used by both the real execution
 * path (risk/engine.ts's assessNewTrade) and the recommendation-preview
 * endpoints (api/routes/scores.ts), so a setup shown on the dashboard always
 * reflects the exact stop/target/quantity that would actually be traded,
 * not a separate, stale approximation.
 */
import { Decimal } from "decimal.js";
import { computeConfidenceTierQuantity, computePositionSize } from "./sizing.js";
import { computeInitialStop, MAX_STOP_DISTANCE_POINTS, MAX_TAKE_PROFIT_DISTANCE_POINTS } from "./stops.js";

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
  /** Cross-version consensus average probability (0-1) -- sets quantity directly via confidence tiers (see risk/sizing.ts's computeConfidenceTierQuantity), replacing the dollar-risk-derived quantity below (2026-07-20, operator request). */
  averageProbability: number;
  /** Overrides stops.ts's default 3:1 -- see risk/engine.ts's assessNewTrade for why every real trade now passes 2:1 (2026-07-29, operator request tied to v5 becoming a required execution gate). */
  takeProfitRMultiple?: Decimal;
  /** Operator-adjustable confidence tiers (SystemState, see execution/mode.ts's setConfidenceTiers) -- defaults to sizing.ts's DEFAULT_CONFIDENCE_TIERS when not supplied (e.g. a caller that hasn't been updated yet). */
  confidenceTiers?: [minAverageProbability: number, quantity: number][];
  /**
   * Strategy-provided explicit stop/target (see strategy/types.ts's
   * Signal.explicitStopPrice/explicitTakeProfitPrice) -- when set, used
   * directly instead of computeInitialStop's generic structure-vs-ATR blend
   * and R-multiple target. computeInitialStop is still called below for its
   * trailTicks (a pure ATR-chandelier distance, unrelated to where the
   * initial stop/target sit) even when both are overridden.
   */
  explicitStopPrice?: Decimal;
  explicitTakeProfitPrice?: Decimal;
}): TradePlan {
  const { side, entryPrice, atrValue, structureSwingPrice, tickSize, pointValue, riskAmount, profitDollars, maxPositionSize, averageProbability, takeProfitRMultiple, confidenceTiers, explicitStopPrice, explicitTakeProfitPrice } = params;

  const stopPlan = computeInitialStop(entryPrice, side, atrValue, structureSwingPrice, { tickSize, takeProfitRMultiple });
  const rawStopPrice = explicitStopPrice ?? stopPlan.stopPrice;
  const rawStopDistancePoints = explicitStopPrice ? entryPrice.minus(explicitStopPrice).abs() : stopPlan.stopDistancePoints;
  const rawTakeProfitPrice = explicitTakeProfitPrice ?? stopPlan.takeProfitPrice;

  // 2026-08-06 (operator request): the 5pt max-stop / 10pt max-target caps
  // apply to every trade this function plans, including a strategy's own
  // explicit stop/target (e.g. strategy/trendPullbackFib.ts's "stop at the
  // 5m 20 EMA") -- computeInitialStop already caps its own structure/ATR
  // output, but that's bypassed entirely once explicitStopPrice/
  // explicitTakeProfitPrice are set, so the same ceiling is re-applied here
  // as the single choke point both the real execution path
  // (risk/engine.ts's assessNewTrade) and the dashboard preview path
  // (api/routes/scores.ts) share.
  const initialStopDistancePoints = Decimal.min(rawStopDistancePoints, MAX_STOP_DISTANCE_POINTS);
  const initialStopPrice = initialStopDistancePoints.equals(rawStopDistancePoints)
    ? rawStopPrice
    : side === "long"
      ? entryPrice.minus(initialStopDistancePoints)
      : entryPrice.plus(initialStopDistancePoints);

  const rawTakeProfitDistancePoints = rawTakeProfitPrice.minus(entryPrice).abs();
  const initialTakeProfitDistancePoints = Decimal.min(rawTakeProfitDistancePoints, MAX_TAKE_PROFIT_DISTANCE_POINTS);
  const initialTakeProfitPrice = initialTakeProfitDistancePoints.equals(rawTakeProfitDistancePoints)
    ? rawTakeProfitPrice
    : side === "long"
      ? entryPrice.plus(initialTakeProfitDistancePoints)
      : entryPrice.minus(initialTakeProfitDistancePoints);

  // Dollar-based sizing is still computed -- its `reason` documents what the
  // $ budget alone would have sized to, for comparison against the
  // confidence-tier quantity that's actually used below.
  const dollarSizing = computePositionSize(riskAmount, initialStopDistancePoints, pointValue, maxPositionSize);
  const confidenceQuantity = computeConfidenceTierQuantity(averageProbability, maxPositionSize, confidenceTiers);
  const quantity = dollarSizing.quantity > 0 ? confidenceQuantity : 0; // no stop, no trade -- see computePositionSize's own zero-quantity cases

  const riskPerContract = initialStopDistancePoints.times(pointValue);
  const actualRiskDollarsAtTier = riskPerContract.times(quantity);
  const sizing = {
    quantity,
    reason: `confidence tier: ${Math.round(averageProbability * 100)}% avg -> ${quantity} contract(s) (actual risk $${actualRiskDollarsAtTier.toFixed(2)}). Dollar-budget sizing alone: ${dollarSizing.reason}`,
  };

  let stopPrice = initialStopPrice;
  let stopDistancePoints = initialStopDistancePoints;
  let sizingReason = sizing.reason;
  let takeProfitPrice = initialTakeProfitPrice;

  // A fixed-dollar profit target must reflect the actual sized quantity
  // (points needed = dollars / (pointValue * quantity)), so it can only be
  // computed once sizing is known -- overrides the stop plan's default
  // R:R-multiple-based target when configured. Skipped when the strategy
  // already provided its own explicit target -- that's more specific to
  // this exact setup than a generic fixed-dollar override, and should win.
  if (profitDollars != null && sizing.quantity > 0 && explicitTakeProfitPrice === undefined) {
    const profitDistance = profitDollars.dividedBy(pointValue.times(sizing.quantity));
    takeProfitPrice = side === "long" ? entryPrice.plus(profitDistance) : entryPrice.minus(profitDistance);

    const actualRiskDollars = stopDistancePoints.times(pointValue).times(sizing.quantity);
    const minRiskDollars = profitDollars.dividedBy(MIN_RISK_REWARD_DENOMINATOR);
    if (actualRiskDollars.lt(minRiskDollars)) {
      const minStopDistance = minRiskDollars.dividedBy(pointValue.times(sizing.quantity));
      // 2026-08-06: the widening floor above must never push the stop past
      // the hard MAX_STOP_DISTANCE_POINTS ceiling (stops.ts) -- that ceiling
      // is meant to be an absolute maximum regardless of which code path
      // computed the distance, not just the default structure/ATR one.
      // Dormant in practice today (no active account has a fixed-dollar
      // profitDollars configured, see docs/BUILD_HISTORY.md's v1.2 "Fixing
      // the win rate" entry), but this only matters if one ever is again.
      if (minStopDistance.lte(MAX_STOP_DISTANCE_POINTS)) {
        stopDistancePoints = minStopDistance;
        stopPrice = side === "long" ? entryPrice.minus(minStopDistance) : entryPrice.plus(minStopDistance);
        sizingReason = `${sizingReason}; stop widened to ${minStopDistance.toFixed(4)} pts to keep risk at/above 1/${MIN_RISK_REWARD_DENOMINATOR} of the $${profitDollars.toFixed(2)} target (was $${actualRiskDollars.toFixed(2)}, floor is $${minRiskDollars.toFixed(2)})`;
      } else {
        sizingReason = `${sizingReason}; risk:reward floor not met but stop left at ${stopDistancePoints.toFixed(4)} pts -- widening to ${minStopDistance.toFixed(4)} pts would exceed the ${MAX_STOP_DISTANCE_POINTS.toString()}pt max-stop cap`;
      }
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
