/**
 * DB access + short TTL cache for which symbols are currently disabled (see
 * prisma's DisabledSymbol model) -- mirrors strategyEnablementCache.ts
 * exactly, one level coarser: this stops EVERY strategy/execution path for
 * the symbol, not just one strategyId. Presence in the underlying table =
 * disabled; a symbol with no row is enabled.
 */
import { prisma } from "../db/client.js";

const CACHE_TTL_MS = 30_000;
let cache: { disabled: Set<string>; computedAt: number } | null = null;

/** Every currently-disabled symbol. TTL-cached; see disableSymbol/enableSymbol for invalidation. */
export async function getDisabledSymbols(): Promise<Set<string>> {
  if (cache && Date.now() - cache.computedAt < CACHE_TTL_MS) return cache.disabled;
  const rows = await prisma.disabledSymbol.findMany({ select: { symbol: true } });
  const disabled = new Set(rows.map((r) => r.symbol));
  cache = { disabled, computedAt: Date.now() };
  return disabled;
}

/** Every disabled symbol with its reason -- for the dashboard toggle panel. */
export async function listDisabledSymbols(): Promise<{ symbol: string; reason: string; createdAt: Date }[]> {
  return prisma.disabledSymbol.findMany({ orderBy: { symbol: "asc" } });
}

export async function disableSymbol(symbol: string, reason: string): Promise<void> {
  await prisma.disabledSymbol.upsert({
    where: { symbol },
    update: { reason },
    create: { symbol, reason },
  });
  cache = null;
}

export async function enableSymbol(symbol: string): Promise<void> {
  await prisma.disabledSymbol.deleteMany({ where: { symbol } });
  cache = null;
}
