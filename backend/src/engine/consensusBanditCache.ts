/**
 * TTL-cached wrapper around scoring/consensusBandit.ts's computeBanditSelection
 * -- same split as fixedTargetEdgeCache.ts: bucket stats move slowly (new
 * resolved outcomes trickle in via outcomeEvaluator.ts's 5-minute cadence),
 * so there's no need to hit the DB on every tick.
 *
 * Live only. Replay must NOT go through this cache -- see
 * replay/replayDecisionContext.ts, which calls computeBanditSelection
 * directly every time, same reasoning fixedTargetEdgeCache.ts's own header
 * comment gives for getFixedTargetEdge: a wall-clock-TTL cache would silently
 * return a wrong-`at` selection across a replay run spanning many historical
 * bars.
 */
import { computeBanditSelection, type BanditSelectionResult } from "../scoring/consensusBandit.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // bucket stats move slowly -- no need to recompute every tick

const cache = new Map<string, { selection: BanditSelectionResult; computedAt: number }>();

// `at` is the caller's as-of time (see decisionCore.ts) -- live and replay
// both pass it explicitly; this cache still keys purely off `bucket` and
// ignores `at` for cache-hit purposes, since live callers only ever call this
// "now" (same convention as getFixedTargetEdge).
export async function getBanditVersionSelection(bucket: string, at: Date): Promise<BanditSelectionResult> {
  const cached = cache.get(bucket);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.selection;

  const selection = await computeBanditSelection(bucket, at);
  cache.set(bucket, { selection, computedAt: Date.now() });
  return selection;
}
