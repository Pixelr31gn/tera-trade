/**
 * Bar rollups (5m/15m/1h/1d) computed from bars_1m in application code.
 *
 * TimescaleDB continuous aggregates aren't available on plain hosted Postgres
 * (Neon), so this replicates that behavior: bucket recent 1-minute bars into
 * coarser resolutions and upsert the result into `bars_rollup`. Cheap enough
 * to run on a schedule (see engine/loop.ts) rather than needing a database
 * feature.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { DEFAULT_INSTRUMENTS } from "./instruments.js";

const RESOLUTIONS: Array<{ label: string; minutes: number }> = [
  { label: "5m", minutes: 5 },
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "1d", minutes: 60 * 24 },
];

function bucketStart(time: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(time.getTime() / ms) * ms);
}

export async function refreshRollupsForSymbol(symbol: string, lookbackHours = 48): Promise<void> {
  const since = new Date(Date.now() - lookbackHours * 3_600_000);
  const bars = await prisma.bar.findMany({
    where: { symbol, time: { gte: since } },
    orderBy: { time: "asc" },
  });
  if (bars.length === 0) return;

  for (const { label, minutes } of RESOLUTIONS) {
    const buckets = new Map<number, { open: Decimal; high: Decimal; low: Decimal; close: Decimal; volume: Decimal }>();
    for (const bar of bars) {
      const bucket = bucketStart(bar.time, minutes).getTime();
      const open = new Decimal(bar.open.toString());
      const high = new Decimal(bar.high.toString());
      const low = new Decimal(bar.low.toString());
      const close = new Decimal(bar.close.toString());
      const volume = new Decimal(bar.volume.toString());

      const existing = buckets.get(bucket);
      if (!existing) {
        buckets.set(bucket, { open, high, low, close, volume });
      } else {
        existing.high = Decimal.max(existing.high, high);
        existing.low = Decimal.min(existing.low, low);
        existing.close = close; // bars are processed in ascending time order, so last write wins
        existing.volume = existing.volume.plus(volume);
      }
    }

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
  for (const spec of DEFAULT_INSTRUMENTS) {
    await refreshRollupsForSymbol(spec.symbol);
  }
}
