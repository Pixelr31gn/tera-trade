/**
 * "Paper Weight" -- a Time & Sales factor for v5's score (2026-10-13,
 * operator: "it uses time and sales to add more points if there are more
 * buys than sells on the time and sales tab ... if a bunch of sells disappear
 * then it will add even more, and the opposite for sells for shorts").
 *
 * Reads the aggressor tape TopstepX already streams (RealTimeTradeLogWithSpeed,
 * classified buy/sell in browserWatch/orderFlowListener.ts) over two rolling
 * windows: the last minute and the minute before it.
 *
 *   imbalance = (buys - sells) / (buys + sells) over the last minute, in [-1, 1]
 *   LONG:  + imbalance x PW_IMBALANCE_MAX_POINTS              when buys lead
 *          + PW_FADE_MAX_POINTS x (how far sells dropped)     when sell volume
 *            fell by PW_FADE_MIN_DROP or more vs the prior minute
 *   SHORT: the mirror -- sells leading, buy volume drying up.
 *
 * Boost-only: it adds to the side the tape favors and never subtracts from the
 * other (operator's description). Below PW_MIN_RECENT_VOLUME contracts, or on
 * a reading older than PW_MAX_AGE_MS, it scores 0. Replay has no tape
 * (ReplayDecisionContext.orderFlow() is null), so it is always 0 there.
 *
 * Pure: freshness is judged against the decision's own bar time `at`.
 * Starting values, not fitted -- tune here.
 */
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";

export const PW_IMBALANCE_MAX_POINTS = 8;
export const PW_FADE_MAX_POINTS = 5;
/** The fading side must have dropped by at least this fraction vs the prior minute to count as "disappearing". */
export const PW_FADE_MIN_DROP = 0.5;
/** Ignore a minute with less total aggressor volume than this -- too thin to mean anything. */
export const PW_MIN_RECENT_VOLUME = 10;
/** The fading side needs at least this much volume in the prior minute for a drop to mean anything. */
export const PW_FADE_MIN_PRIOR_VOLUME = 10;
export const PW_MAX_AGE_MS = 60_000;

export interface PaperWeight {
  adjustmentPoints: number;
  description: string;
}

export function computePaperWeight(snapshot: OrderFlowSnapshot | null, side: "long" | "short", at: Date): PaperWeight {
  const buy = snapshot?.tapeBuyRecent;
  const sell = snapshot?.tapeSellRecent;
  const atMs = snapshot?.tapeAtMs;
  if (buy === undefined || sell === undefined || atMs === undefined) {
    return { adjustmentPoints: 0, description: "Paper Weight: no Time & Sales reading -- 0 pts" };
  }
  if (at.getTime() - atMs > PW_MAX_AGE_MS) {
    return { adjustmentPoints: 0, description: "Paper Weight: Time & Sales reading is stale for this bar -- 0 pts" };
  }
  const total = buy + sell;
  if (total < PW_MIN_RECENT_VOLUME) {
    return { adjustmentPoints: 0, description: `Paper Weight: only ${total} contracts traded in the last minute -- too thin, 0 pts` };
  }

  const imbalance = (buy - sell) / total;
  const sideImbalance = side === "long" ? imbalance : -imbalance;
  const imbalancePoints = sideImbalance > 0 ? sideImbalance * PW_IMBALANCE_MAX_POINTS : 0;

  // "A bunch of sells disappear": for a long, the opposing (sell) side's
  // volume dropping hard vs the prior minute; for a short, the buy side's.
  const opposingNow = side === "long" ? sell : buy;
  const opposingPrior = (side === "long" ? snapshot?.tapeSellPrior : snapshot?.tapeBuyPrior) ?? 0;
  const drop = opposingPrior >= PW_FADE_MIN_PRIOR_VOLUME ? (opposingPrior - opposingNow) / opposingPrior : 0;
  const fadePoints = drop >= PW_FADE_MIN_DROP ? drop * PW_FADE_MAX_POINTS : 0;

  const adjustmentPoints = Math.round((imbalancePoints + fadePoints) * 10) / 10;
  const opposingLabel = side === "long" ? "sells" : "buys";
  const fadeText = fadePoints > 0 ? `; ${opposingLabel} dried up ${Math.round(drop * 100)}% vs the prior minute (+${fadePoints.toFixed(1)})` : "";
  return {
    adjustmentPoints,
    description: `Paper Weight: last minute ${buy} buys / ${sell} sells${fadeText} -- ${side} +${adjustmentPoints.toFixed(1)} pts`,
  };
}
