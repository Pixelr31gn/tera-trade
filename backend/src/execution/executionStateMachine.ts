/**
 * Execution state machine -- Phases 6-9 of the Execution Decision Engine:
 * dynamic re-scoring per bar, time decay, opportunity-cost cancellation,
 * and the WAITING -> BUILDING_ENTRY -> READY -> RESTING_ORDER -> FILLED
 * lifecycle. RESTING_ORDER/FILLED/CANCELLED are set directly by the
 * orchestrator (executionDecisionEngine.ts) once it actually talks to the
 * broker -- that's inherently async/impure, so it lives outside this pure
 * state-transition function. MANAGED/COMPLETE aren't modeled here at all:
 * once a trade fills, the existing Trade-row lifecycle (engine/loop.ts's
 * manageLiveOpenTrade, already battle-tested tonight) takes over -- there's
 * no reason to duplicate that.
 */
import { Decimal } from "decimal.js";
import type { EntryQualityScore } from "./entryQualityModel.js";
import { selectBestEntry } from "./entryQualityModel.js";

export type ExecutionState = "waiting" | "building_entry" | "ready" | "resting_order" | "filled" | "cancelled";

export interface ExecutionOpportunity {
  symbol: string;
  side: "long" | "short";
  strategyId: string;
  signalScore: number;
  createdAt: Date;
  state: ExecutionState;
  bestEntry: EntryQualityScore | null;
  brokerOrderId: string | null;
  cancelReason: string | null;
  /** Set when the resting limit order is actually placed -- Phase 6's time-to-fill logging measures from here, not from opportunity creation (which includes however long building_entry took). */
  restingOrderPlacedAt: Date | null;
  /** Snapshot at opportunity creation -- the baseline checkOpportunityCost compares against. */
  baseline: { entryScore: number; stopDistance: number; rewardDistance: number; atrValue: number; trendSlope: number | null };
  /**
   * Frozen at the moment the resting order is placed -- everything needed to
   * record a fill (or re-check age) on a LATER tick that has no fresh signal
   * of its own to recompute these from. Without this, polling for a fill had
   * to piggyback on a brand-new signal recomputing its own stopPrice/
   * quantity/etc, which meant the poll only ever ran when a fresh signal
   * happened to fire again for this exact symbol+side -- silently starving
   * the fill-check the moment that stopped happening (see the 2026-07-20
   * incident where a real fill went undetected for ~20 minutes and, worse,
   * a LATER signal for the OPPOSITE side collided with this same slot).
   */
  orderDetails: {
    accountId: number;
    quantity: number;
    stopPrice: Decimal;
    takeProfitPrice: Decimal | null;
    regimeTrend: string;
    regimeVol: string;
    explanation: string;
    scoreId: number | null;
  } | null;
}

export interface AgePenalty {
  ageSeconds: number;
  penaltyPct: number; // 0-1, fraction subtracted from score
  shouldCancel: boolean;
}

// Hand-set decay table, exactly as specified -- not fitted against
// resolved outcomes yet (see entryQualityModel.ts's header comment on the
// same posture for the scoring weights).
export function computeAgePenalty(ageSeconds: number): AgePenalty {
  const ageMinutes = ageSeconds / 60;
  if (ageMinutes >= 8) return { ageSeconds, penaltyPct: 1, shouldCancel: true };
  if (ageMinutes >= 6) return { ageSeconds, penaltyPct: 0.08, shouldCancel: false };
  if (ageMinutes >= 4) return { ageSeconds, penaltyPct: 0.05, shouldCancel: false };
  if (ageMinutes >= 2) return { ageSeconds, penaltyPct: 0.02, shouldCancel: false };
  return { ageSeconds, penaltyPct: 0, shouldCancel: false };
}

export interface OpportunityCostCheck {
  cancel: boolean;
  reasons: string[];
}

// Hand-set thresholds (30% score drop, 30% reward shrink, 30% stop growth,
// 50% ATR expansion, 2x slope growth) -- documented, not fitted.
export function checkOpportunityCost(params: {
  baseline: ExecutionOpportunity["baseline"];
  currentEntryScore: number;
  currentStopDistance: number;
  currentRewardDistance: number;
  currentAtrValue: number;
  currentTrendSlope: number | null;
}): OpportunityCostCheck {
  const { baseline, currentEntryScore, currentStopDistance, currentRewardDistance, currentAtrValue, currentTrendSlope } = params;
  const reasons: string[] = [];

  const scoreDropPct = baseline.entryScore > 0 ? (baseline.entryScore - currentEntryScore) / baseline.entryScore : 0;
  if (scoreDropPct > 0.3) {
    reasons.push(`entry score dropped ${(scoreDropPct * 100).toFixed(0)}% (${baseline.entryScore.toFixed(1)} -> ${currentEntryScore.toFixed(1)})`);
  }
  if (currentRewardDistance < baseline.rewardDistance * 0.7) {
    reasons.push(`reward distance shrunk (${baseline.rewardDistance.toFixed(2)} -> ${currentRewardDistance.toFixed(2)})`);
  }
  if (currentStopDistance > baseline.stopDistance * 1.3) {
    reasons.push(`stop distance grew (${baseline.stopDistance.toFixed(2)} -> ${currentStopDistance.toFixed(2)})`);
  }
  if (currentAtrValue > baseline.atrValue * 1.5) {
    reasons.push(`ATR expanded (${baseline.atrValue.toFixed(2)} -> ${currentAtrValue.toFixed(2)})`);
  }
  if (baseline.trendSlope !== null && currentTrendSlope !== null && Math.abs(currentTrendSlope) > Math.abs(baseline.trendSlope) * 2) {
    reasons.push(`trend accelerated (slope ${baseline.trendSlope.toFixed(4)} -> ${currentTrendSlope.toFixed(4)})`);
  }

  return { cancel: reasons.length > 0, reasons };
}

export interface AdvanceStateParams {
  opportunity: ExecutionOpportunity;
  scores: EntryQualityScore[];
  minThreshold: number;
  now: Date;
  currentStopDistance: number;
  currentRewardDistance: number;
  currentAtrValue: number;
  currentTrendSlope: number | null;
}

export interface AdvanceStateResult {
  opportunity: ExecutionOpportunity;
  agePenalty: AgePenalty;
  opportunityCost: OpportunityCostCheck | null;
}

/**
 * One tick of the pre-fill lifecycle: applies time decay, checks
 * opportunity cost, and re-scores the ladder to decide whether the
 * opportunity should move toward READY, stay put, or be cancelled. Never
 * touches a broker -- returns the *decision*; the orchestrator
 * (executionDecisionEngine.ts) is what actually places/cancels an order in
 * response to a state change.
 */
export function advanceExecutionState(params: AdvanceStateParams): AdvanceStateResult {
  const { opportunity, scores, minThreshold, now, currentStopDistance, currentRewardDistance, currentAtrValue, currentTrendSlope } = params;

  if (opportunity.state === "cancelled" || opportunity.state === "filled" || opportunity.state === "resting_order") {
    // Resting-order/filled/cancelled are terminal or broker-driven from
    // here -- this function only manages the pre-order waiting states.
    return { opportunity, agePenalty: computeAgePenalty((now.getTime() - opportunity.createdAt.getTime()) / 1000), opportunityCost: null };
  }

  const ageSeconds = (now.getTime() - opportunity.createdAt.getTime()) / 1000;
  const agePenalty = computeAgePenalty(ageSeconds);
  if (agePenalty.shouldCancel) {
    return {
      opportunity: { ...opportunity, state: "cancelled", cancelReason: `setup exceeded max age (${(ageSeconds / 60).toFixed(1)} min)` },
      agePenalty,
      opportunityCost: null,
    };
  }

  // The raw top score (regardless of whether it clears minThreshold) is
  // what opportunity cost tracks -- "nothing hit the READY bar yet" is a
  // different condition from "the setup's quality actually crashed to
  // zero," and conflating them here would cancel a merely-not-ready-yet
  // opportunity as if it had degraded.
  const topScore = scores.length > 0 ? Math.max(...scores.map((s) => s.score)) : 0;
  const best = selectBestEntry(scores, minThreshold);
  const opportunityCost = checkOpportunityCost({
    baseline: opportunity.baseline,
    currentEntryScore: topScore,
    currentStopDistance,
    currentRewardDistance,
    currentAtrValue,
    currentTrendSlope,
  });
  if (opportunityCost.cancel) {
    return {
      opportunity: { ...opportunity, state: "cancelled", cancelReason: opportunityCost.reasons.join("; "), bestEntry: best },
      agePenalty,
      opportunityCost,
    };
  }

  if (!best) {
    return { opportunity: { ...opportunity, state: "building_entry", bestEntry: null }, agePenalty, opportunityCost };
  }

  const adjustedScore = best.score * (1 - agePenalty.penaltyPct);
  const state: ExecutionState = adjustedScore >= minThreshold ? "ready" : "building_entry";
  return { opportunity: { ...opportunity, state, bestEntry: best }, agePenalty, opportunityCost };
}
