import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { DEFAULT_INSTRUMENTS, type InstrumentSpec } from "./instruments.js";
import { fetchYahooChart } from "./yahooClient.js";

const logger = childLogger("backfill");

// Yahoo's free chart endpoint does not serve interval=1m for CME futures
// continuous contracts (=F symbols) -- only for equities. 5-minute is the
// finest granularity actually available for these symbols, going back ~60
// days; `bars_1m` (the table name is a holdover from the original spec)
// stores this 5-minute data for futures.
const INTRADAY_INTERVAL = "5m";
const MAX_INTRADAY_LOOKBACK_DAYS = 60;

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
  const bars = await fetchYahooChart(spec.dataSymbol, `${MAX_INTRADAY_LOOKBACK_DAYS}d`, INTRADAY_INTERVAL);
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
