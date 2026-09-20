/**
 * TTL-cached wrapper around scoring/sessionSwitchingAgent.ts's
 * computeSessionSwitchingSelection -- same split as sessionPerformanceCache.ts/
 * consensusBanditCache.ts/fixedTargetEdgeCache.ts.
 *
 * Keyed by session (not sessionStart -- this agent's stats are cumulative
 * across all history for that session type, never reset at a session
 * boundary, see sessionSwitchingAgent.ts's own comment). 5-minute TTL,
 * matching sessionPerformanceCache.ts's cadence -- this is shadow-only
 * logging, not gating anything, so there's no "react immediately" pressure,
 * but there's equally no reason to diverge from the sibling cache's cadence.
 *
 * Live only. Never called from replay -- this is invoked from
 * engine/loop.ts's attemptExecution, which (unlike evaluateNewSignals'
 * decideOnBar body) is never called by src/replay/decisionCore.ts. See
 * .claude/rules/replay-harness.md.
 */
import { computeSessionSwitchingSelection, type SessionSwitchingSelection } from "../scoring/sessionSwitchingAgent.js";
import type { TradingSession } from "../analytics/session.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<TradingSession, { selection: SessionSwitchingSelection; computedAt: number }>();

// Single-flight dedup: the caller (engine/loop.ts's attemptExecution) invokes
// this fire-and-forget on every candidate signal, which can mean a burst of
// calls for the same session within a single tick/bar before the first
// cache-populating DB round trip has resolved. Without this map, every call
// in that burst independently sees "no fresh cache entry" and independently
// fires its own 10-query round trip (5 arms x 2 counts) -- confirmed live
// 2026-09-03: this alone pushed tests/engineIntegration.test.ts from its
// documented ~30s baseline to ~68s. Concurrent callers on a cold cache now
// await the SAME in-flight promise instead.
const inFlight = new Map<TradingSession, Promise<SessionSwitchingSelection>>();

export async function getSessionSwitchingSelection(session: TradingSession, at: Date): Promise<SessionSwitchingSelection> {
  const cached = cache.get(session);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.selection;

  const pending = inFlight.get(session);
  if (pending) return pending;

  const promise = computeSessionSwitchingSelection(session, at)
    .then((selection) => {
      cache.set(session, { selection, computedAt: Date.now() });
      return selection;
    })
    .finally(() => {
      inFlight.delete(session);
    });
  inFlight.set(session, promise);
  return promise;
}
