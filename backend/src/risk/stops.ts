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

  const takeProfitDistance = distance.times(takeProfitRMultiple);
  const takeProfitPrice = side === "long" ? entryPrice.plus(takeProfitDistance) : entryPrice.minus(takeProfitDistance);

  const trailDistance = atrValue.times(chandelierAtrMultiplier);
  const trailTicks = tickSize.gt(0) ? Math.max(1, trailDistance.dividedBy(tickSize).floor().toNumber()) : 1;

  return { stopPrice, stopDistancePoints: distance, basis, takeProfitPrice, trailTicks };
}
