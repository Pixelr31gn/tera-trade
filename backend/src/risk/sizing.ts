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

/**
 * Confidence-tier sizing (2026-07-20, operator request): quantity is set
 * directly by the cross-version consensus average, not derived from the
 * dollar-risk budget -- the dollar-based computePositionSize above was
 * almost always landing on 1 contract regardless of how confident a setup
 * was (a wide-but-valid stop against a fixed $50 budget floors there most
 * of the time), which meant real conviction differences between setups
 * never showed up as position size. Real $ risk now scales with the tier
 * (quantity x stop distance x point value), not the other way around --
 * a deliberate tradeoff the operator chose explicitly over keeping the
 * dollar budget as a hard ceiling.
 */
const CONFIDENCE_TIERS: [minAverageProbability: number, quantity: number][] = [
  [0.82, 3],
  [0.71, 2],
  [0.65, 1],
];

export function computeConfidenceTierQuantity(averageProbability: number, maxPositionSize: number): number {
  // Consensus requires at least 2/3 versions to individually clear the score
  // threshold to reach execution at all (see engine/loop.ts's
  // determineConsensus) -- the *average* can still land below 65% in that
  // case (e.g. two versions just over 65% and a third near 0%). A setup
  // that already cleared every other gate is never sized to zero for
  // landing in that gap -- same "never below 1" floor as the dollar-based
  // sizing above, just re-anchored to confidence tiers instead of dollars.
  const tierQuantity = CONFIDENCE_TIERS.find(([min]) => averageProbability >= min)?.[1] ?? 1;
  return Math.min(tierQuantity, maxPositionSize);
}
