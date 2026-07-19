/**
 * Point-based position sizing.
 *
 * The stop distance (in points, from the strategy's own ATR/structure read)
 * is the primary input -- `riskAmount` only decides how many contracts to
 * scale *up* to when the stop is tight enough that one contract would
 * underspend the budget. It must never veto a setup down to zero contracts
 * just because a wider (but still perfectly valid) stop means one contract's
 * risk exceeds the nominal dollar figure -- a real, structure-validated,
 * score-cleared setup that gets silently sized to zero is indistinguishable
 * from "the system doesn't work" (2026-07-16 operator report: exactly this
 * was blocking real breakout_donchian_20 signals on NQ, whose stop distance
 * routinely runs past what a fixed $50 budget affords one MNQ contract at
 * $2/point). So the floor is always 1 contract whenever there's a genuinely
 * valid stop, never 0 -- the dollar amount is left to float above the
 * nominal riskAmount rather than block the trade; maxPositionSize and the
 * account-level circuit breakers (daily loss/drawdown/consecutive-losses,
 * see risk/circuitBreakers.ts) remain the real portfolio-level risk controls.
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

  // Never below 1 -- a valid, structure-based stop always buys at least one
  // contract, even if that contract's actual dollar risk runs above the
  // nominal riskAmount budget (see module comment).
  const rawQuantity = Math.max(1, riskAmount.dividedBy(riskPerContract).floor().toNumber());
  const capped = rawQuantity > maxPositionSize;
  const quantity = Math.min(rawQuantity, maxPositionSize);

  const actualRiskDollars = riskPerContract.times(quantity);
  let reason: string;
  if (rawQuantity === 1 && actualRiskDollars.gt(riskAmount)) {
    reason = `$${riskAmount.toFixed(2)} risk budget doesn't fully cover this ${stopDistancePoints} point stop's $${riskPerContract.toFixed(2)}/contract risk -- taking the minimum 1 contract anyway (actual risk $${actualRiskDollars.toFixed(2)}) rather than skip a valid setup`;
  } else {
    reason = `risking $${riskAmount.toFixed(2)} over a ${stopDistancePoints} point stop sizes to ${rawQuantity} contract(s)`;
    if (capped) reason += `, capped to the account's max position size of ${maxPositionSize}`;
  }
  return { quantity, riskAmount, stopDistancePoints, cappedByMaxPosition: capped, reason };
}
