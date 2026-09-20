/**
 * Shared `bars_daily` reader -- extracted from engine/dailyTrendCache.ts and
 * engine/dailyEmaTrendCache.ts, which each independently defined the exact
 * same query/mapping (only their lookback window differs: 200 days for the
 * regime classifier, 90 for the EMA trend, see each cache's own comment for
 * why). Kept in marketData/ rather than either cache module, since neither
 * owns this data more than the other.
 */
import { prisma } from "../db/client.js";
import type { OhlcBar } from "../regime/indicators.js";

export async function loadDailyBars(symbol: string, lookbackDays: number): Promise<OhlcBar[]> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000);
  const rows = await prisma.dailyBar.findMany({ where: { symbol, date: { gte: since } }, orderBy: { date: "asc" } });
  return rows.map((r) => ({ time: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}
