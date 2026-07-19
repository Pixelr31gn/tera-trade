/**
 * Bar rollups (5m/15m/30m/1h/4h) computed from bars_1m in application code.
 *
 * TimescaleDB continuous aggregates aren't available on plain hosted Postgres,
 * so this replicates that behavior: bucket recent 1-minute bars into coarser
 * resolutions and upsert the result into `bars_rollup`. Cheap enough to run
 * on a schedule (see index.ts) rather than needing a database feature.
 *
 * No "1d" resolution here -- the daily timeframe already has a real ~1yr-deep
 * source (`DailyBar`/`bars_daily`, backfilled from an external source, see
 * engine/dailyTrendCache.ts), and rolling a shallow "1d" out of bars_1m would
 * just shadow that with far less history.
 */
import { prisma } from "../db/client.js";
import type { OhlcBar } from "../regime/indicators.js";
import { ACTIVE_INSTRUMENTS } from "./instruments.js";

// classifyRegime's longest-period indicator (atrPercentile) wants up to a
// 100-bar lookback plus its own 14-bar ATR warm-up -- ~114 bars, same
// appetite regardless of what each bar's own duration represents (see
// engine/dailyTrendCache.ts's identical reasoning, applied per calendar day
// there instead of per resolution here). 114 bars at each resolution's
// duration, converted to calendar hours with a 7/5 cushion for weekends NQ
// doesn't trade, rounded up:
//   5m  -> 9.5h trading  -> ~13h  -> 48h  (unchanged default, generous)
//   15m -> 28.5h trading -> ~40h  -> 72h  (3d)
//   30m -> 57h trading   -> ~80h  -> 120h (5d)
//   1h  -> 114h trading  -> ~160h -> 240h (10d)
//   4h  -> 456h trading  -> ~638h -> 720h (30d)
// bars_1m has only had genuinely clean (non-degenerate) history since
// marketData/minuteBarAggregator.ts was fixed -- so the 4h leg specifically
// won't have 720h/114 bars available for a couple of weeks after that fix
// shipped, and 1h will take a few days. That's expected, not a bug: callers
// (engine/timeframeTrendCache.ts) treat a too-short history as "not enough
// data yet" and omit that leg rather than computing a misleading read.
const RESOLUTIONS: Array<{ label: string; minutes: number; lookbackHours: number }> = [
  { label: "5m", minutes: 5, lookbackHours: 48 },
  { label: "15m", minutes: 15, lookbackHours: 72 },
  { label: "30m", minutes: 30, lookbackHours: 120 },
  { label: "1h", minutes: 60, lookbackHours: 240 },
  { label: "4h", minutes: 240, lookbackHours: 720 },
];

export interface OhlcvAgg {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function bucketStart(time: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(time.getTime() / ms) * ms);
}

/**
 * Pure aggregation: buckets `bars` into `minutes`-wide OHLCV candles, keyed
 * by bucket-start epoch ms. Excludes any bucket whose start falls before
 * `since` -- a bucket starting before the query window means the bars
 * belonging to its first part are missing from `bars`, so aggregating it
 * anyway would produce an incomplete (wrong high/low/volume) candle. Without
 * this, a bucket that was fully -- and correctly -- computed on an earlier
 * run could get silently overwritten with a partial one simply because
 * `since` later moved past its start (this happened for every resolution
 * here before the fix, just never surfaced since nothing called this before).
 * The newest, still-forming bucket is unaffected by this exclusion (its
 * start is always >= since for any reasonable lookback) and is expected to
 * look partial -- that's just it not having finished yet.
 */
export function aggregateBarsIntoBuckets(bars: OhlcBar[], minutes: number, since: Date): Map<number, OhlcvAgg> {
  const buckets = new Map<number, OhlcvAgg>();
  for (const bar of bars) {
    const bucketMs = bucketStart(bar.time, minutes).getTime();
    const existing = buckets.get(bucketMs);
    if (!existing) {
      buckets.set(bucketMs, { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close; // bars are processed in ascending time order, so last write wins
      existing.volume += bar.volume;
    }
  }

  const sinceMs = since.getTime();
  for (const bucketMs of buckets.keys()) {
    if (bucketMs < sinceMs) buckets.delete(bucketMs);
  }
  return buckets;
}

export async function refreshRollupsForSymbol(symbol: string): Promise<void> {
  // Fetched once at the widest resolution's window, filtered per resolution
  // in-memory below -- avoids 5 separate DB round-trips for what's otherwise
  // the same underlying bars_1m rows.
  const maxLookbackHours = Math.max(...RESOLUTIONS.map((r) => r.lookbackHours));
  const rows = await prisma.bar.findMany({
    where: { symbol, time: { gte: new Date(Date.now() - maxLookbackHours * 3_600_000) } },
    orderBy: { time: "asc" },
  });
  if (rows.length === 0) return;

  const bars: OhlcBar[] = rows.map((r) => ({
    time: r.time,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));

  for (const { label, minutes, lookbackHours } of RESOLUTIONS) {
    const since = new Date(Date.now() - lookbackHours * 3_600_000);
    const buckets = aggregateBarsIntoBuckets(bars, minutes, since);

    for (const [bucketMs, agg] of buckets) {
      const bucket = new Date(bucketMs);
      await prisma.barRollup.upsert({
        where: { resolution_symbol_bucket: { resolution: label, symbol, bucket } },
        update: {
          open: agg.open.toString(),
          high: agg.high.toString(),
          low: agg.low.toString(),
          close: agg.close.toString(),
          volume: agg.volume.toString(),
        },
        create: {
          resolution: label,
          symbol,
          bucket,
          open: agg.open.toString(),
          high: agg.high.toString(),
          low: agg.low.toString(),
          close: agg.close.toString(),
          volume: agg.volume.toString(),
        },
      });
    }
  }
}

export async function refreshAllRollups(): Promise<void> {
  for (const spec of ACTIVE_INSTRUMENTS) {
    await refreshRollupsForSymbol(spec.symbol);
  }
}
