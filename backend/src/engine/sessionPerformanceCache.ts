/**
 * TTL-cached wrapper around scoring/sessionPerformance.ts's
 * computeSessionPerformanceSelection -- same split as
 * consensusBanditCache.ts/fixedTargetEdgeCache.ts.
 *
 * Shorter TTL than consensusBanditCache.ts's 60 minutes, deliberately: the
 * whole point of this gate is to react quickly to a version's CURRENT
 * session performance ("even a one-point win-rate edge should switch
 * immediately," operator request) -- 5 minutes matches
 * engine/outcomeEvaluator.ts's own resolution cadence, the fastest new
 * session evidence can actually arrive.
 *
 * Live only. Replay must NOT go through this cache -- see
 * replay/replayDecisionContext.ts, which calls
 * computeSessionPerformanceSelection directly every time, same reasoning
 * consensusBanditCache.ts's own header comment gives: a wall-clock-TTL
 * cache would silently return a wrong-`at` selection across a replay run
 * spanning many historical bars.
 */
import { getSessionStart } from "../analytics/session.js";
import { computeSessionPerformanceSelection, type SessionPerformanceSelection } from "../scoring/sessionPerformance.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<number, { selection: SessionPerformanceSelection; computedAt: number }>();

// Keyed by sessionStart's own timestamp -- a session boundary crossing
// naturally produces a new key with no separate invalidation logic needed,
// same convention as consensusBanditCache.ts keying off `bucket`.
export async function getSessionPerformanceSelection(at: Date): Promise<SessionPerformanceSelection> {
  const sessionStartMs = getSessionStart(at).getTime();
  const cached = cache.get(sessionStartMs);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.selection;

  const selection = await computeSessionPerformanceSelection(new Date(sessionStartMs), at);
  cache.set(sessionStartMs, { selection, computedAt: Date.now() });

  // Bounded map size for this long-running process -- only the current
  // session's entry is ever read going forward, so evict the rest.
  for (const key of cache.keys()) {
    if (key !== sessionStartMs) cache.delete(key);
  }

  return selection;
}
