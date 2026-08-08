/**
 * Holds the most recent order-flow snapshot per symbol (see
 * browserWatch/orderFlowListener.ts), plus a bounded recent-history ring
 * buffer for the /api/market/order-flow/:symbol/history dashboard chart.
 * In-memory only -- reset on restart, same caveat as liveAccountOverride.ts
 * and the MAE/MFE excursion tracking in engine/loop.ts. Replaced the old
 * order_flow_snapshots DB table (2026-07-20 DB audit): scoring only ever
 * read the latest in-memory snapshot, never the persisted table, so
 * persisting every flush to Postgres forever was pure unread backlog.
 */
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";

const latest = new Map<string, OrderFlowSnapshot>();

export interface OrderFlowHistoryPoint extends OrderFlowSnapshot {
  time: Date;
}

// Per-symbol cap -- generous enough for the dashboard's history chart
// without growing unbounded like the DB table it replaces.
const MAX_HISTORY_PER_SYMBOL = 500;
const history = new Map<string, OrderFlowHistoryPoint[]>();

export function setLatestOrderFlowSnapshot(snapshot: OrderFlowSnapshot): void {
  latest.set(snapshot.symbol, snapshot);
}

export function getLatestOrderFlowSnapshot(symbol: string): OrderFlowSnapshot | null {
  return latest.get(symbol) ?? null;
}

export function getAllLatestOrderFlowSnapshots(): OrderFlowSnapshot[] {
  return [...latest.values()];
}

export function appendOrderFlowHistory(snapshot: OrderFlowSnapshot, time: Date): void {
  const points = history.get(snapshot.symbol) ?? [];
  points.push({ ...snapshot, time });
  if (points.length > MAX_HISTORY_PER_SYMBOL) points.splice(0, points.length - MAX_HISTORY_PER_SYMBOL);
  history.set(snapshot.symbol, points);
}

export function getOrderFlowHistory(symbol: string, limit: number): OrderFlowHistoryPoint[] {
  const points = history.get(symbol) ?? [];
  return points.slice(Math.max(0, points.length - limit));
}
