/**
 * DB access + short TTL cache for which strategies are currently disabled
 * (see prisma's DisabledStrategy model, assistant/tools.ts's
 * disable_strategy/enable_strategy tools). Presence in the underlying table
 * = disabled; a strategyId with no row is enabled, same "opt-in gate" shape
 * as engine/dailyPlanZoneCache.ts.
 */
import { prisma } from "../db/client.js";

const CACHE_TTL_MS = 30_000;
let cache: { disabled: Set<string>; computedAt: number } | null = null;

/** Every currently-disabled strategyId. TTL-cached; see disableStrategy/enableStrategy for invalidation. */
export async function getDisabledStrategyIds(): Promise<Set<string>> {
  if (cache && Date.now() - cache.computedAt < CACHE_TTL_MS) return cache.disabled;
  const rows = await prisma.disabledStrategy.findMany({ select: { strategyId: true } });
  const disabled = new Set(rows.map((r) => r.strategyId));
  cache = { disabled, computedAt: Date.now() };
  return disabled;
}

/** Every disabled strategy with its reason -- for the assistant's get_disabled_strategies read tool and any dashboard display. */
export async function listDisabledStrategies(): Promise<{ strategyId: string; reason: string; createdAt: Date }[]> {
  return prisma.disabledStrategy.findMany({ orderBy: { createdAt: "desc" } });
}

export async function disableStrategy(strategyId: string, reason: string): Promise<void> {
  await prisma.disabledStrategy.upsert({
    where: { strategyId },
    update: { reason },
    create: { strategyId, reason },
  });
  cache = null;
}

export async function enableStrategy(strategyId: string): Promise<void> {
  await prisma.disabledStrategy.deleteMany({ where: { strategyId } });
  cache = null;
}
