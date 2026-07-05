import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { DEFAULT_INSTRUMENTS, type InstrumentSpec } from "./instruments.js";
import { fetchYahooChart } from "./yahooClient.js";

const logger = childLogger("backfill");

const MAX_INTRADAY_LOOKBACK_DAYS = 7;

export async function ensureInstrumentsSeeded(): Promise<void> {
  for (const spec of DEFAULT_INSTRUMENTS) {
    await prisma.instrument.upsert({
      where: { symbol: spec.symbol },
      update: {},
      create: {
        symbol: spec.symbol,
        dataSymbol: spec.dataSymbol,
        exchange: spec.exchange,
        tickSize: spec.tickSize.toString(),
        pointValue: spec.pointValue.toString(),
      },
    });
  }
}

export async function backfillDaily(spec: InstrumentSpec, days: number): Promise<number> {
  const range = `${Math.max(days, 30)}d`;
  const bars = await fetchYahooChart(spec.dataSymbol, range, "1d");
  if (bars.length === 0) {
    logger.warn({ symbol: spec.symbol }, "daily_backfill_empty");
    return 0;
  }

  for (const bar of bars) {
    const date = new Date(Date.UTC(bar.time.getUTCFullYear(), bar.time.getUTCMonth(), bar.time.getUTCDate()));
    await prisma.dailyBar.upsert({
      where: { date_symbol: { date, symbol: spec.symbol } },
      update: { open: bar.open.toString(), high: bar.high.toString(), low: bar.low.toString(), close: bar.close.toString(), volume: bar.volume.toString() },
      create: {
        date,
        symbol: spec.symbol,
        open: bar.open.toString(),
        high: bar.high.toString(),
        low: bar.low.toString(),
        close: bar.close.toString(),
        volume: bar.volume.toString(),
      },
    });
  }
  logger.info({ symbol: spec.symbol, rows: bars.length }, "daily_backfill_done");
  return bars.length;
}

export async function backfillRecentIntraday(spec: InstrumentSpec): Promise<number> {
  const bars = await fetchYahooChart(spec.dataSymbol, `${MAX_INTRADAY_LOOKBACK_DAYS}d`, "1m");
  if (bars.length === 0) {
    logger.warn({ symbol: spec.symbol }, "intraday_backfill_empty");
    return 0;
  }

  for (const bar of bars) {
    await prisma.bar.upsert({
      where: { time_symbol: { time: bar.time, symbol: spec.symbol } },
      update: { open: bar.open.toString(), high: bar.high.toString(), low: bar.low.toString(), close: bar.close.toString(), volume: bar.volume.toString() },
      create: {
        time: bar.time,
        symbol: spec.symbol,
        open: bar.open.toString(),
        high: bar.high.toString(),
        low: bar.low.toString(),
        close: bar.close.toString(),
        volume: bar.volume.toString(),
      },
    });
  }
  logger.info({ symbol: spec.symbol, rows: bars.length }, "intraday_backfill_done");
  return bars.length;
}

export async function runFullBackfill(days = 365): Promise<void> {
  await ensureInstrumentsSeeded();
  for (const spec of DEFAULT_INSTRUMENTS) {
    await backfillDaily(spec, days);
    await backfillRecentIntraday(spec);
  }
}
