/**
 * DB access + short TTL cache for the AI assistant's daily-plan take-profit
 * target (2026-08-31, operator request -- see risk/stops.ts's
 * DAILY_PLAN_TAKE_PROFIT_FRACTION and prisma's DailyPlanTakeProfitTarget for
 * the full history). Mirrors dailyPlanZoneCache.ts's shape/TTL exactly --
 * same session-scoping (analytics/session.ts's getSessionStart), same
 * 30s TTL, same "assistant sets it, expires at the next session boundary"
 * lifecycle as the daily-plan zones it's set alongside.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { getSessionStart } from "../analytics/session.js";
import { DAILY_PLAN_TAKE_PROFIT_FRACTION, HARD_TAKE_PROFIT_DOLLARS } from "../risk/stops.js";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { likelyMovePoints: Decimal | null; computedAt: number }>();

function cacheKey(symbol: string, sessionStart: Date): string {
  return `${symbol}|${sessionStart.toISOString()}`;
}

/** This session's assistant-estimated likely move for `symbol` -- null (not an error) when the assistant hasn't set one yet. TTL-cached; see setDailyPlanTakeProfitTarget for invalidation. */
export async function getActiveDailyPlanTakeProfitTarget(symbol: string, at: Date): Promise<Decimal | null> {
  const sessionStart = getSessionStart(at);
  const key = cacheKey(symbol, sessionStart);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.computedAt < CACHE_TTL_MS) return hit.likelyMovePoints;

  const row = await prisma.dailyPlanTakeProfitTarget.findFirst({ where: { symbol, sessionStart }, orderBy: { createdAt: "desc" } });
  const likelyMovePoints = row ? new Decimal(row.likelyMovePoints.toString()) : null;
  cache.set(key, { likelyMovePoints, computedAt: Date.now() });
  return likelyMovePoints;
}

/**
 * Sets (replaces) this session's take-profit-target estimate for `symbol`.
 * Same "replaces, not additive" posture as setDailyPlanZones -- one coherent
 * read per session, not an accumulating log.
 */
export async function setDailyPlanTakeProfitTarget(symbol: string, likelyMovePoints: number, label: string, at: Date = new Date()): Promise<void> {
  const sessionStart = getSessionStart(at);
  await prisma.$transaction([
    prisma.dailyPlanTakeProfitTarget.deleteMany({ where: { symbol, sessionStart } }),
    prisma.dailyPlanTakeProfitTarget.create({ data: { symbol, sessionStart, likelyMovePoints: likelyMovePoints.toString(), label } }),
  ]);
  cache.delete(cacheKey(symbol, sessionStart));
}

/**
 * Resolves the real hardTakeProfitDollars value risk/engine.ts's
 * assessNewTrade should use for `symbol` right now -- DAILY_PLAN_TAKE_PROFIT_FRACTION
 * of this session's assistant-estimated likely move when one has been set,
 * falling back to the original static HARD_TAKE_PROFIT_DOLLARS value
 * otherwise (assistant hasn't run yet this session, or this symbol isn't in
 * either source at all, in which case this correctly returns undefined and
 * the symbol keeps the normal ATR/structure/R-multiple pipeline). Since
 * 2026-08-31's R-multiple fix (see risk/engine.ts's hardTakeProfitDollars
 * branch), this value is now only actually used as the TARGET directly when
 * no real daily-plan-range stop exists yet to scale an R-multiple off of --
 * see getAssistantTakeProfitCapPoints below for the value used once one does.
 */
export async function resolveHardTakeProfitDollars(symbol: string, at: Date): Promise<number | undefined> {
  const likelyMovePoints = await getActiveDailyPlanTakeProfitTarget(symbol, at);
  if (likelyMovePoints !== null) return likelyMovePoints.times(DAILY_PLAN_TAKE_PROFIT_FRACTION).toNumber();
  return HARD_TAKE_PROFIT_DOLLARS[symbol];
}

/**
 * This session's real assistant-estimated take-profit CAP for `symbol`, in
 * points -- DAILY_PLAN_TAKE_PROFIT_FRACTION of its likely-move read, or null
 * when the assistant hasn't set one yet this session. Deliberately distinct
 * from resolveHardTakeProfitDollars above, which also folds in the static
 * HARD_TAKE_PROFIT_DOLLARS fallback -- a caller needs to tell "a real
 * assistant read exists, use it as an honest ceiling" apart from "nothing's
 * been set yet, don't cap anything against it" (2026-08-31, operator report:
 * TP and SL had no relationship to each other at all -- e.g. NQ trades with
 * a 130pt daily-plan-range stop against a flat 5pt target. Fixed by scaling
 * the target off the real stop via takeProfitRMultiple, capped by this value
 * so it never demands more than the assistant's own honest read of today's
 * realistic range).
 */
export async function getAssistantTakeProfitCapPoints(symbol: string, at: Date): Promise<Decimal | null> {
  const likelyMovePoints = await getActiveDailyPlanTakeProfitTarget(symbol, at);
  return likelyMovePoints !== null ? likelyMovePoints.times(DAILY_PLAN_TAKE_PROFIT_FRACTION) : null;
}

/** Every symbol's active take-profit-target row (value + label) for the session `at` falls within -- for dashboard display. Bypasses the cache, same posture as dailyPlanZoneCache.ts's listActiveDailyPlanZones. */
export async function listActiveDailyPlanTakeProfitTargets(at: Date = new Date()): Promise<Record<string, { likelyMovePoints: Decimal; label: string }>> {
  const sessionStart = getSessionStart(at);
  const rows = await prisma.dailyPlanTakeProfitTarget.findMany({ where: { sessionStart }, orderBy: { symbol: "asc" } });
  const bySymbol: Record<string, { likelyMovePoints: Decimal; label: string }> = {};
  for (const r of rows) {
    bySymbol[r.symbol] = { likelyMovePoints: new Decimal(r.likelyMovePoints.toString()), label: r.label };
  }
  return bySymbol;
}
