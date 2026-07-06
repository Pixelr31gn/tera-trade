/**
 * Pure aggregation for the "does a long setup in this (symbol, session)
 * actually reach a fixed point target before its stop, historically?" stat --
 * see engine/fixedTargetEdgeCache.ts for the DB-driven computation that feeds
 * this, and scoring/gate.ts for where the result hard-gates long entries.
 */
import type { OutcomeLabel } from "./outcomeSimulation.js";

export interface FixedTargetEdgeStats {
  sampleSize: number;
  winRate: number | null;
}

export function summarizeFixedTargetOutcomes(labels: OutcomeLabel[]): FixedTargetEdgeStats {
  const wins = labels.filter((l) => l === "win").length;
  const losses = labels.filter((l) => l === "loss").length;
  const resolved = wins + losses;
  return { sampleSize: resolved, winRate: resolved > 0 ? wins / resolved : null };
}
