/**
 * Plain-English explanation rendering.
 *
 * Every scored setup, skipped setup, sizing decision, stop placement,
 * trailing adjustment, and news-driven pause is rendered to a short,
 * human-readable sentence here and persisted next to the row it explains
 * (scores.explanation, trades.explanation).
 */
import { Decimal } from "decimal.js";
import type { RiskAssessment } from "../risk/engine.js";
import type { GatedScore } from "../scoring/gate.js";

export function explainScore(symbol: string, side: string, gated: GatedScore, threshold: number): string {
  const pct = `${Math.round(gated.probability * 100)}%`;
  // Sorting by |contribution| used to surface a setup's strongest-*supporting*
  // factors even when explaining a *skip* -- a skipped setup with a strong
  // ADX reading (say 15/20) but a weak/ranging structure reading (5/20)
  // would show "ADX confirms strong trend" as a "key factor" for why it was
  // skipped, which reads as actively contradicting the decision. Sorted by
  // raw contribution instead: descending (strongest support first) when
  // taken, ascending (biggest detractors first) when skipped, so the factors
  // shown always actually explain the decision instead of just being the
  // loudest numbers regardless of which way they point.
  const sorted = [...gated.factors].sort((a, b) => (gated.decision === "taken" ? b.contribution - a.contribution : a.contribution - b.contribution));
  // v6 is a fixed set of exactly 5 weighted criteria (see ruleScorerV6.ts),
  // not a variable-length list of minor adjustments like v1/v2/v3/v5 --
  // truncating to 3 silently drops 2 of them, and since a skipped setup
  // often has several criteria all tied at 0 contribution, which 2 survive
  // the cut is arbitrary (stable-sort insertion order). Show all 5 always.
  const topFactors = gated.modelUsed === "rule_v6" ? sorted : sorted.slice(0, 3);
  const factorText = topFactors.map((f) => f.description).join("; ");

  if (gated.decision === "taken") {
    return `${side.toUpperCase()} ${symbol}: scored ${pct} confidence (>= ${Math.round(threshold * 100)}% threshold, model=${gated.modelUsed}). Key factors: ${factorText}.`;
  }
  if (gated.blockReason) {
    return `${side.toUpperCase()} ${symbol}: scored ${pct} confidence (cleared the ${Math.round(threshold * 100)}% threshold) but blocked -- ${gated.blockReason}. Key factors: ${factorText}.`;
  }
  return `${side.toUpperCase()} ${symbol}: scored ${pct} confidence, below the ${Math.round(threshold * 100)}% threshold -- setup skipped, no trade taken. Key factors: ${factorText}.`;
}

export function explainRiskRejection(symbol: string, side: string, assessment: RiskAssessment): string {
  return `${side.toUpperCase()} ${symbol}: risk engine blocked this trade -- ${assessment.reason}`;
}

export function explainTradeEntry(symbol: string, side: string, quantity: number, entryPrice: Decimal, assessment: RiskAssessment, scoreExplanation: string): string {
  return (
    `${scoreExplanation} Entered ${side} ${quantity} ${symbol} @ ${entryPrice}. ` +
    `Stop ${assessment.stopPrice} (${assessment.stopDistancePoints} pts), ` +
    `target ${assessment.takeProfitPrice}, trailing after breakeven by ${assessment.trailTicks} ticks. ` +
    `${assessment.reason}`
  );
}

export function explainTradeExit(symbol: string, side: string, exitReason: string, exitPrice: Decimal, pnl: Decimal): string {
  const outcome = pnl.gte(0) ? "a gain" : "a loss";
  const reasonText: Record<string, string> =
    {
      stop: "the stop-loss was hit",
      target: "the take-profit target was hit",
      trailing_stop: "the trailing stop was hit, locking in a favorable move",
      manual: "the position was closed manually",
      kill_switch: "the risk engine's kill switch force-closed this position",
    };
  const reason = reasonText[exitReason] ?? exitReason;
  return `Closed ${side} ${symbol} @ ${exitPrice} for ${outcome} of ${pnl.toFixed(2)} -- ${reason}.`;
}

export function explainNewsPause(symbol: string, eventName: string, impact: string, minutesToEvent: number | null): string {
  const when = minutesToEvent !== null && minutesToEvent > 0 ? `in ${Math.round(minutesToEvent)} minutes` : "moments ago";
  return `${symbol}: new entries paused because '${eventName}' (${impact} impact) releases ${when}. Trading will resume once the news risk window passes.`;
}

export function explainKillSwitch(reason: string): string {
  return `Kill switch engaged: ${reason}. All new entries are blocked until an operator reviews and clears it.`;
}
