/**
 * DB access + short TTL cache for which (strategyId, symbol) pairs are currently disabled (see
 * prisma's DisabledStrategySymbol model) -- mirrors strategyEnablementCache.ts/
 * symbolEnablementCache.ts exactly, one dimension finer: takes one strategyId out of live signal
 * generation for one specific symbol only, leaving it enabled everywhere else. Presence in the
 * underlying table = disabled for that pair; a (strategyId, symbol) with no row is enabled.
 */
import { prisma } from "../db/client.js";

const CACHE_TTL_MS = 30_000;
let cache: { disabled: Set<string>; computedAt: number } | null = null;

/** Stable composite key for a (strategyId, symbol) pair -- the one place this encoding is defined, so every caller/test stays in sync. */
export function strategySymbolKey(strategyId: string, symbol: string): string {
  return `${strategyId}|${symbol}`;
}

/** Every currently-disabled (strategyId, symbol) pair, as composite keys (see strategySymbolKey). TTL-cached; see disableStrategySymbol/enableStrategySymbol for invalidation. */
export async function getDisabledStrategySymbolPairs(): Promise<Set<string>> {
  if (cache && Date.now() - cache.computedAt < CACHE_TTL_MS) return cache.disabled;
  const rows = await prisma.disabledStrategySymbol.findMany({ select: { strategyId: true, symbol: true } });
  const disabled = new Set(rows.map((r) => strategySymbolKey(r.strategyId, r.symbol)));
  cache = { disabled, computedAt: Date.now() };
  return disabled;
}

/** Every disabled (strategyId, symbol) pair with its reason -- for the assistant's get_disabled_strategy_symbols read tool and any dashboard display. */
export async function listDisabledStrategySymbols(): Promise<{ strategyId: string; symbol: string; reason: string; createdAt: Date }[]> {
  return prisma.disabledStrategySymbol.findMany({ orderBy: [{ strategyId: "asc" }, { symbol: "asc" }] });
}

export async function disableStrategySymbol(strategyId: string, symbol: string, reason: string): Promise<void> {
  await prisma.disabledStrategySymbol.upsert({
    where: { strategyId_symbol: { strategyId, symbol } },
    update: { reason },
    create: { strategyId, symbol, reason },
  });
  cache = null;
}

export async function enableStrategySymbol(strategyId: string, symbol: string): Promise<void> {
  await prisma.disabledStrategySymbol.deleteMany({ where: { strategyId, symbol } });
  cache = null;
}
