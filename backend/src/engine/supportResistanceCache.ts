/**
 * Cached wrapper around analytics/supportResistance.ts for API exposure --
 * so the levels an entry is actually being gated against (see
 * risk/engine.ts) are visible/verifiable on the dashboard, not just
 * implicit in a rejection reason string.
 */
import { atr as computeAtr } from "../regime/indicators.js";
import { computeSupportResistanceLevels, type SrLevel } from "../analytics/supportResistance.js";
import { loadRecentBars } from "./bootstrap.js";

const CACHE_TTL_MS = 15_000;

export interface SrSnapshot {
  symbol: string;
  currentPrice: number | null;
  atrValue: number | null;
  levels: SrLevel[];
}

const cache = new Map<string, { snapshot: SrSnapshot; computedAt: number }>();

export async function getSupportResistanceLevels(symbol: string): Promise<SrSnapshot> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.snapshot;

  const bars = await loadRecentBars(symbol, 300);
  if (bars.length === 0) {
    const empty: SrSnapshot = { symbol, currentPrice: null, atrValue: null, levels: [] };
    cache.set(symbol, { snapshot: empty, computedAt: Date.now() });
    return empty;
  }

  const currentPrice = bars.at(-1)!.close;
  const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
  const atrValue = atrSeries.length > 0 ? atrSeries.at(-1)! : null;
  const levels = atrValue !== null ? computeSupportResistanceLevels(bars, currentPrice, atrValue) : [];

  const snapshot: SrSnapshot = { symbol, currentPrice, atrValue, levels };
  cache.set(symbol, { snapshot, computedAt: Date.now() });
  return snapshot;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetSupportResistanceCacheForTests(): void {
  cache.clear();
}
