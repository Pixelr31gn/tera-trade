/**
 * Live wrapper around analytics/ppm.ts -- pulls the last 15 minutes of raw
 * price ticks for a symbol and computes up/down points-per-minute. Cached
 * briefly (a few seconds) since this is meant to feel like a live
 * speedometer the dashboard polls frequently, not something recomputed from
 * scratch on every request.
 */
import { prisma } from "../db/client.js";
import { computePpm, type PpmResult } from "../analytics/ppm.js";

const WINDOW_MINUTES = 15;
const CACHE_TTL_MS = 3000;

export interface PpmSnapshot extends PpmResult {
  symbol: string;
}

const cache = new Map<string, { snapshot: PpmSnapshot; computedAt: number }>();

async function loadTicks(symbol: string): Promise<{ time: Date; close: number }[]> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  const rows = await prisma.bar.findMany({
    where: { symbol, time: { gte: since } },
    orderBy: { time: "asc" },
    select: { time: true, close: true },
  });
  return rows.map((r) => ({ time: r.time, close: Number(r.close) }));
}

export async function getPpm(symbol: string): Promise<PpmSnapshot> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.snapshot;

  const ticks = await loadTicks(symbol);
  const result = computePpm(ticks, WINDOW_MINUTES);
  const snapshot: PpmSnapshot = { symbol, ...result };
  cache.set(symbol, { snapshot, computedAt: Date.now() });
  return snapshot;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetPpmCacheForTests(): void {
  cache.clear();
}
