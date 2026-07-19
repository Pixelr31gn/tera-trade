/**
 * Multi-timeframe trend direction (9/50/200-day MA stack) plus Fibonacci
 * retracement/extension levels from the most recent daily swing -- a manual
 * decision-support reference for where to place a stop-loss/take-profit on
 * a live trade (see components/QuickOrderPanel.tsx), not an automated
 * scoring signal -- nothing here gates or scores a setup.
 */
import { prisma } from "../db/client.js";
import { classifyMaStack, type MaStack } from "../analytics/movingAverages.js";
import { computeFibLevels, findSwing, type FibLevel } from "../analytics/fibonacci.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // derived from daily bars -- moves at most once/day
// A 30-trading-day window for "the current trend's" swing high/low -- long
// enough to capture a real swing, short enough to stay relevant to a trade
// being placed today rather than an old, since-resolved move.
const FIB_SWING_LOOKBACK_DAYS = 30;

export interface TrendLevels {
  symbol: string;
  maStack: MaStack;
  swingHigh: number | null;
  swingLow: number | null;
  swingDirection: "up" | "down" | null;
  fibLevels: FibLevel[];
}

const cache = new Map<string, { levels: TrendLevels; computedAt: number }>();

async function computeTrendLevels(symbol: string): Promise<TrendLevels> {
  const rows = await prisma.dailyBar.findMany({ where: { symbol }, orderBy: { date: "asc" } });
  const closes = rows.map((r) => Number(r.close));

  const maStack = classifyMaStack(closes);

  const recentBars = rows.slice(-FIB_SWING_LOOKBACK_DAYS).map((r) => ({ high: Number(r.high), low: Number(r.low) }));
  const swing = findSwing(recentBars);
  const fibLevels = swing ? computeFibLevels(swing.high, swing.low, swing.direction) : [];

  return {
    symbol,
    maStack,
    swingHigh: swing?.high ?? null,
    swingLow: swing?.low ?? null,
    swingDirection: swing?.direction ?? null,
    fibLevels,
  };
}

export async function getTrendLevels(symbol: string): Promise<TrendLevels> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.levels;

  const levels = await computeTrendLevels(symbol);
  cache.set(symbol, { levels, computedAt: Date.now() });
  return levels;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetTrendLevelsCacheForTests(): void {
  cache.clear();
}
