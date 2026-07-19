/**
 * Holds the most recent order-flow snapshot per symbol (see
 * browserWatch/orderFlowListener.ts). In-memory only -- reset on restart,
 * same caveat as liveAccountOverride.ts and the MAE/MFE excursion tracking
 * in engine/loop.ts. Not yet read by the scoring engine (see
 * orderFlowListener.ts's module comment) -- exposed via /api/market/order-flow
 * for now so the feed can be visually verified before it drives any decision.
 */
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";

const latest = new Map<string, OrderFlowSnapshot>();

export function setLatestOrderFlowSnapshot(snapshot: OrderFlowSnapshot): void {
  latest.set(snapshot.symbol, snapshot);
}

export function getLatestOrderFlowSnapshot(symbol: string): OrderFlowSnapshot | null {
  return latest.get(symbol) ?? null;
}

export function getAllLatestOrderFlowSnapshots(): OrderFlowSnapshot[] {
  return [...latest.values()];
}
