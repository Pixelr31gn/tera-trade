/**
 * Stop-loss, take-profit, and trailing-stop rules.
 *
 * Every position must have a stop before it can be opened -- enforced here
 * and again in risk/engine.ts's assessNewTrade, defense in depth. The initial
 * stop is whichever is *tighter* of a structure-based swing level and an ATR
 * multiple, so a strategy can't accidentally take on more risk than the ATR
 * model implies just because the last swing point was far away.
 */
import { Decimal } from "decimal.js";

export interface StopPlan {
  stopPrice: Decimal;
  stopDistancePoints: Decimal;
  basis: "structure" | "atr";
  takeProfitPrice: Decimal;
  trailTicks: number;
}

// Hard point-based caps (2026-08-06, operator request): the tightest
// possible risk profile regardless of instrument or the ATR/structure
// distance computed below -- no stop wider than 5 points, no target further
// than 10 points, ever. Deliberately a flat number, not ATR-scaled, unlike
// every other distance in this file (see the takeProfitRMultiple comment
// below and docs/BUILD_HISTORY.md's v1.2 "Risk:reward floor" entry for why
// per-instrument ATR scaling exists at all -- ES's real ATR-based stop runs
// ~4pt but NQ's runs ~25pt). Operator's explicit, informed call after being
// told this flattens NQ/CL/GC down to the same 5pt/10pt ceiling ES already
// runs close to -- a real behavior change for those instruments, likely
// more stop-outs from ordinary noise there. Applied last, after both the
// structure/ATR stop and the R-multiple target are computed.
export const MAX_STOP_DISTANCE_POINTS = new Decimal("5");
export const MAX_TAKE_PROFIT_DISTANCE_POINTS = new Decimal("10");

export function computeInitialStop(
  entryPrice: Decimal,
  side: "long" | "short",
  atrValue: Decimal,
  structureSwingPrice: Decimal | null,
  opts: { atrMultiplier?: Decimal; takeProfitRMultiple?: Decimal; tickSize?: Decimal; chandelierAtrMultiplier?: Decimal } = {}
): StopPlan {
  const atrMultiplier = opts.atrMultiplier ?? new Decimal("1.5");
  // 3.0 (not the more common 2.0) so the point-based target already satisfies
  // tradePlan.ts's MIN_RISK_REWARD_DENOMINATOR floor by construction -- see
  // that file's comment for why a fixed-dollar target decoupled from the
  // actual stop distance was dragging tight, structurally-correct stops out
  // to an arbitrary ~4-5pt distance whenever position size got capped.
  const takeProfitRMultiple = opts.takeProfitRMultiple ?? new Decimal("3.0");
  const tickSize = opts.tickSize ?? new Decimal("0.25");
  const chandelierAtrMultiplier = opts.chandelierAtrMultiplier ?? new Decimal("3.0");

  const atrStopDistance = atrValue.times(atrMultiplier);
  const atrStopPrice = side === "long" ? entryPrice.minus(atrStopDistance) : entryPrice.plus(atrStopDistance);

  let stopPrice: Decimal;
  let distance: Decimal;
  let basis: "structure" | "atr";

  if (structureSwingPrice !== null) {
    const structureDistance = entryPrice.minus(structureSwingPrice).abs();
    if (structureDistance.gt(0) && structureDistance.lt(atrStopDistance)) {
      stopPrice = structureSwingPrice;
      distance = structureDistance;
      basis = "structure";
    } else {
      stopPrice = atrStopPrice;
      distance = atrStopDistance;
      basis = "atr";
    }
  } else {
    stopPrice = atrStopPrice;
    distance = atrStopDistance;
    basis = "atr";
  }

  if (distance.gt(MAX_STOP_DISTANCE_POINTS)) {
    distance = MAX_STOP_DISTANCE_POINTS;
    stopPrice = side === "long" ? entryPrice.minus(distance) : entryPrice.plus(distance);
  }

  let takeProfitDistance = distance.times(takeProfitRMultiple);
  if (takeProfitDistance.gt(MAX_TAKE_PROFIT_DISTANCE_POINTS)) {
    takeProfitDistance = MAX_TAKE_PROFIT_DISTANCE_POINTS;
  }
  const takeProfitPrice = side === "long" ? entryPrice.plus(takeProfitDistance) : entryPrice.minus(takeProfitDistance);

  const trailDistance = atrValue.times(chandelierAtrMultiplier);
  const trailTicks = tickSize.gt(0) ? Math.max(1, trailDistance.dividedBy(tickSize).floor().toNumber()) : 1;

  return { stopPrice, stopDistancePoints: distance, basis, takeProfitPrice, trailTicks };
}

// v1.3: fixed trailing-stop distance and activation threshold for the real
// (browser-controlled) broker -- a separate, simpler mechanism from the
// chandelier ATR trail above (which stays simulated-broker-only). Hand-set
// per operator request, not fitted/ATR-derived: activation is halfway from
// entry to the take-profit target; once reached, a real broker-side
// Trailing Stop order (see brokers/types.ts's placeTrailingStop) takes over
// as the trade's downside protection, replacing the internal stop-price
// check in engine/loop.ts's manageLiveOpenTrade.
export const TRAILING_STOP_ACTIVATION_FRACTION = 0.5;
export const TRAILING_STOP_DISTANCE_TICKS = 30;

/** Has price reached the halfway point from entry to the take-profit target, in the trade's favor? */
export function hasReachedTrailingStopActivation(
  entryPrice: Decimal,
  takeProfitPrice: Decimal,
  side: "long" | "short",
  high: Decimal,
  low: Decimal
): boolean {
  const activationPrice = entryPrice.plus(takeProfitPrice.minus(entryPrice).times(TRAILING_STOP_ACTIVATION_FRACTION));
  return side === "long" ? high.gte(activationPrice) : low.lte(activationPrice);
}
