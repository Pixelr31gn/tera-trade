/**
 * Turns a flagged underperformer bucket into a ScoutPitch row, reusing Scout's own write_pitch
 * (scout/pitchStore.ts) rather than a separate alert table/channel -- the operator already has a
 * review workflow for these (`npm run scout:rate`, the daily digest), so a new signal source
 * should feed that pipeline, not duplicate it. dedupeKey collision (same title) means a
 * recurring underperformer reinforces its existing pitch (occurrenceCount++, evidence appended)
 * instead of spawning a new one each run -- see pitchStore.ts's own header comment.
 */
import { writePitch, type WritePitchResult } from "../scout/pitchStore.js";
import type { UnderperformerBucket } from "./types.js";

const DIMENSION_LABEL: Record<UnderperformerBucket["dimension"], string> = {
  marketStructure: "market structure",
  liquidity: "liquidity",
  priceAction: "price action",
};

function titleFor(bucket: UnderperformerBucket): string {
  return `underperformer: ${bucket.dimension}=${bucket.label} in ${bucket.session}`;
}

export async function writeUnderperformerPitch(bucket: UnderperformerBucket): Promise<WritePitchResult> {
  const dimensionLabel = DIMENSION_LABEL[bucket.dimension];
  return writePitch({
    title: titleFor(bucket),
    problem: `Across ${bucket.sampleSize} scored setups in the ${bucket.session} session, ${dimensionLabel} "${bucket.label}" averages ${bucket.avgRMultiple.toFixed(3)}R -- a consistent loser, not noise. This kept requiring manual review each cycle instead of a proactive flag before the next batch of setups goes live.`,
    proposedAgent: `Tighten or disable the risk filter for ${dimensionLabel}="${bucket.label}" when session=${bucket.session} -- e.g. skip taking new setups in this combo, or require a higher score threshold, until avgR recovers above the floor on fresh data.`,
    toolsNeeded: ["query_recent_trades_and_sessions", "write_pitch"],
    costEstimate: "$0 -- pure aggregation over already-computed data, no LLM call",
    frequencyEstimate: "daily",
    category: "friction",
    evidenceSummary: `crossRegimeAnalyzer flagged ${dimensionLabel}="${bucket.label}" in ${bucket.session}: ${bucket.sampleSize} samples, avgR ${bucket.avgRMultiple.toFixed(3)}.`,
    evidenceSource: "runtime",
  });
}
