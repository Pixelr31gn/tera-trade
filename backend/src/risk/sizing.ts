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
/** Default shape only -- callers should pass the operator's current SystemState tiers (see execution/mode.ts's setConfidenceTiers); this is just the fallback when none is supplied. */
export const DEFAULT_CONFIDENCE_TIERS: [minAverageProbability: number, quantity: number][] = [
  [0.85, 3],
  [0.75, 2],
  [0.65, 1],
];

// Operator-adjustable at runtime (2026-08-02, see execution/mode.ts's
// setConfidenceTiers) -- was a hardcoded module constant (65/71/82%) until
// then. Kept as a plain parameter, not a DB read, so this stays a pure
// function per CLAUDE.md's rule for risk/ -- callers resolve the current
// tiers from SystemState/DecisionContext and pass them in.
export function computeConfidenceTierQuantity(
  averageProbability: number,
  maxPositionSize: number,
  tiers: [minAverageProbability: number, quantity: number][] = DEFAULT_CONFIDENCE_TIERS,
): number {
  // Consensus requires at least 2/3 versions to individually clear the score
  // threshold to reach execution at all (see engine/loop.ts's
  // determineConsensus) -- the *average* can still land below the lowest
  // tier in that case (e.g. two versions just over 65% and a third near 0%,
  // or a v7-solo execution where the other five versions score near 0%
  // while v7 alone clears 65%+). A setup that already cleared every other
  // gate is never sized to zero for landing in that gap.
  //
  // Floor is the LOWEST configured tier's own quantity, not a hardcoded
  // constant (2026-08-11, operator correction: "dollar based sizing should
  // only matter for entry and exit points, the amount of contracts taken
  // should be determined by the certainty % of the recommendations" --
  // dollar-based sizing's floor-of-1 in computePositionSize above is a
  // stop-validity gate, not a real fallback quantity, so it was never a
  // good model for this one; a hardcoded 1 here had nothing to do with
  // certainty at all, contradicting the whole point of tier-based sizing
  // and silently undersizing relative to what an operator who set Tier 1's
  // quantity above 1 actually configured).
  const sortedDescending = [...tiers].sort((a, b) => b[0] - a[0]);
  const lowestTierQuantity = sortedDescending.at(-1)?.[1] ?? 1; // only reached if `tiers` is empty, which the 3-tier API contract never allows
  const tierQuantity = sortedDescending.find(([min]) => averageProbability >= min)?.[1] ?? lowestTierQuantity;
  return Math.min(tierQuantity, maxPositionSize);
}
