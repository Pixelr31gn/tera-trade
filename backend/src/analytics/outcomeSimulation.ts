/**
 * Pure retrospective outcome simulation: given a hypothetical entry/stop/
 * target and the bars that followed, would this setup have won, lost, or
 * never resolved either way? Used by engine/outcomeEvaluator.ts to label
 * *skipped* setups the same way a real trade gets labeled by its actual
 * fill/exit -- without this, the dataset would only ever learn from trades
 * that were taken, never from the ones that were correctly (or incorrectly)
 * passed on.
 */
import type { OhlcBar } from "../regime/indicators.js";

export type OutcomeLabel = "win" | "loss" | "no_resolution";

export interface HypotheticalOutcome {
  label: OutcomeLabel;
  rMultiple: number;
}

/**
 * Walks `subsequentBars` (ascending time, all after the entry) checking
 * whether the stop or target would have hit first. Mirrors
 * SimulatedBroker.evaluateBar's convention: if a single bar's range could
 * have hit both, the stop is assumed to have hit first (conservative).
 */
export function evaluateHypotheticalOutcome(
  side: "long" | "short",
  entryPrice: number,
  stopPrice: number,
  takeProfitPrice: number,
  subsequentBars: OhlcBar[]
): HypotheticalOutcome {
  const stopDistance = Math.abs(entryPrice - stopPrice);

  for (const bar of subsequentBars) {
    const hitStop = side === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
    const hitTarget = side === "long" ? bar.high >= takeProfitPrice : bar.low <= takeProfitPrice;
    if (hitStop) return { label: "loss", rMultiple: -1 };
    if (hitTarget) {
      const rMultiple = stopDistance > 0 ? Math.abs(takeProfitPrice - entryPrice) / stopDistance : 0;
      return { label: "win", rMultiple };
    }
  }

  const last = subsequentBars[subsequentBars.length - 1];
  const direction = side === "long" ? 1 : -1;
  const rMultiple = last && stopDistance > 0 ? ((last.close - entryPrice) * direction) / stopDistance : 0;
  return { label: "no_resolution", rMultiple };
}
