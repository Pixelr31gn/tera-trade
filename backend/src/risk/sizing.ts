/**
 * Fixed-fractional position sizing.
 *
 * Every trade's size is derived from the stop-loss distance, never from a
 * target win rate or a fixed contract count -- this is the concrete
 * mechanism behind "never assume losses are impossible": the position is
 * sized so that if the stop is hit, the loss equals (at most) the configured
 * per-trade risk percentage of account equity.
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
  accountEquity: Decimal,
  perTradeRiskPct: Decimal,
  stopDistancePoints: Decimal,
  pointValue: Decimal,
  maxPositionSize: number
): SizingResult {
  if (stopDistancePoints.lte(0)) {
    return { quantity: 0, riskAmount: new Decimal(0), stopDistancePoints, cappedByMaxPosition: false, reason: "no stop distance provided -- no stop, no trade" };
  }

  const riskAmount = accountEquity.times(perTradeRiskPct).dividedBy(100);
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
      reason: `stop distance too wide for ${perTradeRiskPct}% risk on this account size -- sized to 0 contracts`,
    };
  }

  let reason = `risking ${perTradeRiskPct}% of equity ($${riskAmount.toFixed(2)}) over a ${stopDistancePoints} point stop sizes to ${rawQuantity} contract(s)`;
  if (capped) reason += `, capped to the account's max position size of ${maxPositionSize}`;
  return { quantity, riskAmount, stopDistancePoints, cappedByMaxPosition: capped, reason };
}
