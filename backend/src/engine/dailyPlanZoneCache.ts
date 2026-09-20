/**
 * DB access + short TTL cache for the AI assistant's daily-plan zones (see
 * risk/engine.ts's DailyPlanZone/classifyDailyPlanZone, assistant/tools.ts's
 * set_daily_plan_zones tool, and assistant/dailyPlanScheduler.ts). Zones
 * change rarely (only when the assistant explicitly sets them), but should
 * still take effect within a bar or two of being set, not up to an hour
 * later -- a much shorter TTL than e.g. openingRangeCache.ts's slow-moving
 * stat.
 *
 * Scoped by SESSION (analytics/session.ts's getSessionStart), not calendar
 * date (2026-08-29) -- a zone set during the New York session has no
 * bearing on the following Asian session's structure, so zones naturally
 * and silently expire at each session boundary rather than persisting
 * stale across a whole UTC day.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { getSessionStart } from "../analytics/session.js";
import type { DailyPlanZone } from "../risk/engine.js";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { zones: DailyPlanZone[]; computedAt: number }>();

function cacheKey(symbol: string, sessionStart: Date): string {
  return `${symbol}|${sessionStart.toISOString()}`;
}

/** Active zones for `symbol` in the session `at` falls within -- empty array (not an error) when the assistant hasn't set any this session. TTL-cached; see setDailyPlanZones for invalidation. */
export async function getActiveDailyPlanZones(symbol: string, at: Date): Promise<DailyPlanZone[]> {
  const sessionStart = getSessionStart(at);
  const key = cacheKey(symbol, sessionStart);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.computedAt < CACHE_TTL_MS) return hit.zones;

  const rows = await prisma.dailyPlanZone.findMany({ where: { symbol, sessionStart } });
  const zones: DailyPlanZone[] = rows.map((r) => ({
    priceLow: new Decimal(r.priceLow.toString()),
    priceHigh: new Decimal(r.priceHigh.toString()),
    enforcement: r.enforcement as "hard" | "soft",
    label: r.label,
  }));
  cache.set(key, { zones, computedAt: Date.now() });
  return zones;
}

export interface DailyPlanZoneInput {
  priceLow: number;
  priceHigh: number;
  enforcement: "hard" | "soft";
  label: string;
}

/**
 * Replaces every zone for `symbol` in the session `at` falls within with
 * `zones` -- not additive. A session's plan is one coherent set of levels,
 * not an accumulating log; calling this twice in one session (e.g. the
 * assistant refreshing its plan mid-session) should reflect the latest read
 * of the market, not layer stale zones under new ones.
 */
export async function setDailyPlanZones(symbol: string, zones: DailyPlanZoneInput[], at: Date = new Date()): Promise<void> {
  const sessionStart = getSessionStart(at);
  await prisma.$transaction([
    prisma.dailyPlanZone.deleteMany({ where: { symbol, sessionStart } }),
    prisma.dailyPlanZone.createMany({
      data: zones.map((z) => ({
        symbol,
        sessionStart,
        priceLow: z.priceLow.toString(),
        priceHigh: z.priceHigh.toString(),
        enforcement: z.enforcement,
        label: z.label,
      })),
    }),
  ]);
  cache.delete(cacheKey(symbol, sessionStart));
}

/** Deletes every zone for `symbol` in the session `at` falls within -- back to the gate's default no-op state for that symbol this session. */
export async function clearDailyPlanZones(symbol: string, at: Date = new Date()): Promise<void> {
  const sessionStart = getSessionStart(at);
  await prisma.dailyPlanZone.deleteMany({ where: { symbol, sessionStart } });
  cache.delete(cacheKey(symbol, sessionStart));
}

/** Every symbol's active zones for the session `at` falls within -- for the assistant's get_daily_plan_zones read tool, the scheduler's cold-start check, and any dashboard display. Bypasses the cache (a full-table read, not the hot per-symbol gate path). */
export async function listActiveDailyPlanZones(at: Date = new Date()): Promise<Record<string, DailyPlanZone[]>> {
  const sessionStart = getSessionStart(at);
  const rows = await prisma.dailyPlanZone.findMany({ where: { sessionStart }, orderBy: [{ symbol: "asc" }, { priceLow: "asc" }] });
  const bySymbol: Record<string, DailyPlanZone[]> = {};
  for (const r of rows) {
    const zone: DailyPlanZone = {
      priceLow: new Decimal(r.priceLow.toString()),
      priceHigh: new Decimal(r.priceHigh.toString()),
      enforcement: r.enforcement as "hard" | "soft",
      label: r.label,
    };
    (bySymbol[r.symbol] ??= []).push(zone);
  }
  return bySymbol;
}
