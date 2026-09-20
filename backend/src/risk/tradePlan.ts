/**
 * Shared stop/target/sizing computation -- used by both the real execution
 * path (risk/engine.ts's assessNewTrade) and the recommendation-preview
 * endpoints (api/routes/scores.ts), so a setup shown on the dashboard always
 * reflects the exact stop/target/quantity that would actually be traded,
 * not a separate, stale approximation.
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import { computeConfidenceTierQuantity, computePositionSize } from "./sizing.js";
import { computeInitialStop, roundAwayFromEntry } from "./stops.js";

// Matches stops.ts's computeInitialStop's own default -- resolved here too since the
// explicit-stop/explicit-target derivation below (2026-09-08) needs the same multiple
// computeInitialStop would have used, for whichever side (stop or target) isn't explicit.
const DEFAULT_TAKE_PROFIT_R_MULTIPLE = new Decimal("3.0");

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
export const MIN_RISK_REWARD_DENOMINATOR = 3;

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
  /** Recent 1-minute bars (2026-08-17, operator request), passed straight through to computeInitialStop's own recentBars option -- see stops.ts for the swing-based stop this enables. Optional: callers without bars handy (e.g. a preview row with no bar-fetch budget) just get the existing ATR/structure sizing, same as before this change. */
  bars?: OhlcBar[];
}): TradePlan {
  const { side, entryPrice, atrValue, structureSwingPrice, tickSize, pointValue, riskAmount, profitDollars, maxPositionSize, averageProbability, takeProfitRMultiple, confidenceTiers, explicitStopPrice, explicitTakeProfitPrice, bars } = params;
  const effectiveTakeProfitRMultiple = takeProfitRMultiple ?? DEFAULT_TAKE_PROFIT_R_MULTIPLE;

  const stopPlan = computeInitialStop(entryPrice, side, atrValue, structureSwingPrice, { tickSize, takeProfitRMultiple, recentBars: bars });

  // 2026-09-08 (operator instruction: "the 1:3 should be calculated based on
  // the tp recommendation... dont do a fixed 15pt to 5pt"). Replaces the old
  // MAX_STOP_DISTANCE_POINTS(5)/MAX_TAKE_PROFIT_DISTANCE_POINTS(15)
  // independent-cap re-application, which pinned every capped trade to
  // almost exactly that same 5pt/15pt pair regardless of what either side's
  // explicit price actually called for. Now: whichever side (stop or
  // target) the strategy did NOT specify explicitly is derived from the one
  // it DID specify, at effectiveTakeProfitRMultiple -- so a strategy naming
  // a real, wide take-profit gets a proportionally wider (not flat-5pt)
  // stop, and a strategy naming a real, tight stop gets a proportionally
  // tighter (not flat-15pt) target. When NEITHER is explicit,
  // computeInitialStop's own stop/target already satisfy this ratio exactly
  // by construction (see that function's own comment) -- used as-is. When
  // BOTH are explicit, that's the strategy's fully-specified setup -- taken
  // as-is, un-derived; risk/engine.ts's assessNewTrade applies the same
  // MIN_REWARD_RISK_RATIO floor as a final backstop (reject rather than
  // silently override a strategy's own two explicit prices).
  let initialStopPrice: Decimal;
  let initialStopDistancePoints: Decimal;
  let initialTakeProfitPrice: Decimal;
  if (explicitStopPrice !== undefined && explicitTakeProfitPrice !== undefined) {
    initialStopPrice = explicitStopPrice;
    initialStopDistancePoints = entryPrice.minus(explicitStopPrice).abs();
    initialTakeProfitPrice = explicitTakeProfitPrice;
  } else if (explicitTakeProfitPrice !== undefined) {
    initialTakeProfitPrice = explicitTakeProfitPrice;
    initialStopDistancePoints = explicitTakeProfitPrice.minus(entryPrice).abs().dividedBy(effectiveTakeProfitRMultiple);
    initialStopPrice = side === "long" ? entryPrice.minus(initialStopDistancePoints) : entryPrice.plus(initialStopDistancePoints);
  } else if (explicitStopPrice !== undefined) {
    initialStopPrice = explicitStopPrice;
    initialStopDistancePoints = entryPrice.minus(explicitStopPrice).abs();
    const targetDistance = initialStopDistancePoints.times(effectiveTakeProfitRMultiple);
    initialTakeProfitPrice = side === "long" ? entryPrice.plus(targetDistance) : entryPrice.minus(targetDistance);
  } else {
    initialStopPrice = stopPlan.stopPrice;
    initialStopDistancePoints = stopPlan.stopDistancePoints;
    initialTakeProfitPrice = stopPlan.takeProfitPrice;
  }

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
      // 2026-08-06, no longer capped as of 2026-09-08: this widening floor
      // used to be bounded by the hard MAX_STOP_DISTANCE_POINTS ceiling
      // (stops.ts), which no longer exists (see this file's own comment on
      // the explicit-stop/explicit-target derivation above -- stop distance
      // is now expected to flex with whatever the real target calls for,
      // not be clamped to a flat point number). Dormant in practice today
      // (no active account has a fixed-dollar profitDollars configured, see
      // docs/BUILD_HISTORY.md's v1.2 "Fixing the win rate" entry), but this
      // only matters if one ever is again.
      stopDistancePoints = minStopDistance;
      stopPrice = side === "long" ? entryPrice.minus(minStopDistance) : entryPrice.plus(minStopDistance);
      sizingReason = `${sizingReason}; stop widened to ${minStopDistance.toFixed(4)} pts to keep risk at/above 1/${MIN_RISK_REWARD_DENOMINATOR} of the $${profitDollars.toFixed(2)} target (was $${actualRiskDollars.toFixed(2)}, floor is $${minRiskDollars.toFixed(2)})`;
    }
  }

  // Tick-rounded as the last step, after every branch above (R-multiple,
  // fixed-dollar target, risk:reward widening) has finished computing --
  // see stops.ts's roundToTick for why this is the single choke point both
  // the real execution path and the recommendations-preview path share.
  return {
    stopPrice: roundAwayFromEntry(stopPrice, entryPrice, tickSize),
    takeProfitPrice: roundAwayFromEntry(takeProfitPrice, entryPrice, tickSize),
    stopDistancePoints,
    trailTicks: stopPlan.trailTicks,
    quantity: sizing.quantity,
    sizingReason,
  };
}
