/**
 * Fixed-fractional position sizing.
 *
 * Every trade's size is derived from the stop-loss distance, never from a
 * target win rate or a fixed contract count -- this is the concrete
 * mechanism behind "never assume losses are impossible": the position is
 * sized so that if the stop is hit, the loss equals (at most) `riskAmount`.
 *
 * `riskAmount` is resolved by the caller (risk/engine.ts) -- either a fixed
 * dollar figure or a percentage of account equity -- this function only
 * knows "how many contracts does this many dollars of risk buy," so it works
 * identically for either mode.
 */
import { Decimal } from "decimal.js";

export interface SizingResult {
  quantity: number;
  riskAmount: Decimal;
  stopDistancePoints: Decimal;
  cappedByMaxPosition: boolean;
  reason: string;
}

export function computePositionSize(
  riskAmount: Decimal,
  stopDistancePoints: Decimal,
  pointValue: Decimal,
  maxPositionSize: number
): SizingResult {
  if (stopDistancePoints.lte(0)) {
    return { quantity: 0, riskAmount, stopDistancePoints, cappedByMaxPosition: false, reason: "no stop distance provided -- no stop, no trade" };
  }

  const riskPerContract = stopDistancePoints.times(pointValue);
  if (riskPerContract.lte(0)) {
    return { quantity: 0, riskAmount, stopDistancePoints, cappedByMaxPosition: false, reason: "invalid point value / stop distance" };
  }

  const rawQuantity = riskAmount.dividedBy(riskPerContract).floor().toNumber();
  const capped = rawQuantity > maxPositionSize;
  const quantity = Math.min(rawQuantity, maxPositionSize);

  if (quantity <= 0) {
    return {
      quantity: 0,
      riskAmount,
      stopDistancePoints,
      cappedByMaxPosition: capped,
      reason: `stop distance too wide for a $${riskAmount.toFixed(2)} risk budget on this account -- sized to 0 contracts`,
    };
  }

  let reason = `risking $${riskAmount.toFixed(2)} over a ${stopDistancePoints} point stop sizes to ${rawQuantity} contract(s)`;
  if (capped) reason += `, capped to the account's max position size of ${maxPositionSize}`;
  return { quantity, riskAmount, stopDistancePoints, cappedByMaxPosition: capped, reason };
}
