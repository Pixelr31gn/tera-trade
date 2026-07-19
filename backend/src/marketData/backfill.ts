import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { ACTIVE_INSTRUMENTS, DEFAULT_INSTRUMENTS, type InstrumentSpec } from "./instruments.js";
import { fetchYahooChart, type YahooBar } from "./yahooClient.js";

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
      // tickSize/pointValue must stay in sync with DEFAULT_INSTRUMENTS on every
      // boot, not just at first creation -- engine/accounting.ts reads
      // pointValue from this table (unlike the rest of the engine, which reads
      // getInstrument() directly), so a stale DB row after a contract-spec
      // change (e.g. switching from full-size to micro contracts) would
      // silently miscalculate live unrealized P&L.
      update: {
        dataSymbol: spec.dataSymbol,
        exchange: spec.exchange,
        tickSize: spec.tickSize.toString(),
        pointValue: spec.pointValue.toString(),
      },
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

  // Historical daily bars for past dates don't change -- bulk-insert and
  // skip rows that already exist instead of one network round-trip per row
  // (an N-row loop of individual upserts against a remote DB was the actual
  // bottleneck behind what first looked like Yahoo rate-limiting).
  const rows = bars.map((bar: YahooBar) => {
    const date = new Date(Date.UTC(bar.time.getUTCFullYear(), bar.time.getUTCMonth(), bar.time.getUTCDate()));
    return {
      date, symbol: spec.symbol,
      open: bar.open.toString(), high: bar.high.toString(), low: bar.low.toString(), close: bar.close.toString(), volume: bar.volume.toString(),
    };
  });
  await prisma.dailyBar.createMany({ data: rows, skipDuplicates: true });

  logger.info({ symbol: spec.symbol, rows: bars.length }, "daily_backfill_done");
  return bars.length;
}

export async function backfillRecentIntraday(spec: InstrumentSpec): Promise<number> {
  const bars = await fetchYahooChart(spec.dataSymbol, `${MAX_INTRADAY_LOOKBACK_DAYS}d`, INTRADAY_INTERVAL);
  if (bars.length === 0) {
    logger.warn({ symbol: spec.symbol }, "intraday_backfill_empty");
    return 0;
  }

  const rows = bars.map((bar: YahooBar) => ({
    time: bar.time, symbol: spec.symbol,
    open: bar.open.toString(), high: bar.high.toString(), low: bar.low.toString(), close: bar.close.toString(), volume: bar.volume.toString(),
  }));
  await prisma.bar.createMany({ data: rows, skipDuplicates: true });

  logger.info({ symbol: spec.symbol, rows: bars.length }, "intraday_backfill_done");
  return bars.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runFullBackfill(days = 365): Promise<void> {
  await ensureInstrumentsSeeded();
  // Only the actively-traded symbols -- see ACTIVE_INSTRUMENTS's comment.
  // CL/GC's existing historical data is untouched, just never re-fetched.
  for (const spec of ACTIVE_INSTRUMENTS) {
    await backfillDaily(spec, days);
    await backfillRecentIntraday(spec);
    // A little breathing room between symbols regardless -- cheap insurance
    // against bursting Yahoo's unauthenticated endpoint.
    await sleep(1000);
  }
}
