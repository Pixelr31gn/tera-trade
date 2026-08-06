/**
 * Holds the most recent regime reading per symbol, for dashboard display
 * only. In-memory, same pattern and caveat as liveOrderFlowCache.ts (reset
 * on restart) -- replaced the old regime_history DB table (2026-07-20 DB
 * audit) once it was confirmed nothing in scoring ever read that table back;
 * every real scoring decision uses a freshly-computed classifyRegime(bars)
 * in-memory, not a persisted row.
 */
export interface RegimeSnapshotView {
  time: Date;
  trendLabel: string;
  volLabel: string;
  confidence: string;
  features: unknown;
}

const latest = new Map<string, RegimeSnapshotView>();

export function setLatestRegimeSnapshot(symbol: string, snapshot: RegimeSnapshotView): void {
  latest.set(symbol, snapshot);
}

export function getLatestRegimeSnapshot(symbol: string): RegimeSnapshotView | null {
  return latest.get(symbol) ?? null;
}
