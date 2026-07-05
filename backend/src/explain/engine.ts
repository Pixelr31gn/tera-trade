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
  const topFactors = [...gated.factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 3);
  const factorText = topFactors.map((f) => f.description).join("; ");

  if (gated.decision === "taken") {
    return `${side.toUpperCase()} ${symbol}: scored ${pct} confidence (>= ${Math.round(threshold * 100)}% threshold, model=${gated.modelUsed}). Key factors: ${factorText}.`;
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
