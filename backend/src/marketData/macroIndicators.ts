/**
 * 10Y Treasury yield (^TNX) and VIX (^VIX) -- real macro context for the
 * narrative session report (2026-08-11, operator request). Both free via
 * the same Yahoo Finance chart endpoint marketData/backfill.ts already uses
 * for daily-bar history (marketData/yahooClient.ts's fetchYahooChart) --
 * confirmed live: both symbols resolve real current values through it, no
 * separate data source or paid feed needed.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { fetchYahooChart } from "./yahooClient.js";

const logger = childLogger("macroIndicators");

export const MACRO_SYMBOLS = ["^TNX", "^VIX"] as const;
export type MacroSymbol = (typeof MACRO_SYMBOLS)[number];

export interface MacroReading {
  symbol: MacroSymbol;
  time: Date;
  value: Decimal;
}

async function fetchLatestMacroReading(symbol: MacroSymbol): Promise<MacroReading | null> {
  const bars = await fetchYahooChart(symbol, "5d", "1d");
  if (bars.length === 0) return null;
  const latest = bars[bars.length - 1]!;
  return { symbol, time: latest.time, value: latest.close };
}

export async function refreshMacroIndicators(): Promise<MacroReading[]> {
  const readings: MacroReading[] = [];
  for (const symbol of MACRO_SYMBOLS) {
    try {
      const reading = await fetchLatestMacroReading(symbol);
      if (!reading) {
        logger.warn({ symbol }, "macro_indicator_fetch_empty");
        continue;
      }
      // Upsert, not create -- Yahoo's still-forming "today" daily bar keeps
      // the same `time` anchor while its value updates intraday. A blind
      // create() here produced real duplicate rows for the identical
      // (symbol, time) pair within an hour of this table existing
      // (confirmed live 2026-08-11); this keeps the latest value under one
      // row per reading instead.
      await prisma.macroIndicator.upsert({
        where: { symbol_time: { symbol: reading.symbol, time: reading.time } },
        update: { value: reading.value.toString() },
        create: { symbol: reading.symbol, time: reading.time, value: reading.value.toString() },
      });
      readings.push(reading);
    } catch (err) {
      // Never throw -- a Yahoo hiccup means "no fresh macro reading this
      // cycle," not "block the engine loop." Same fail-soft posture as
      // dealerGexCache.ts.
      logger.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, "macro_indicator_fetch_failed");
    }
  }
  return readings;
}

/**
 * One-off (or periodically re-run, safe either way -- skipDuplicates makes
 * it idempotent) historical backfill -- confirmed live (2026-08-11) that
 * Yahoo's free endpoint genuinely serves 10 years of daily history for both
 * ^TNX and ^VIX through this exact same fetchYahooChart call, no different
 * data source or paid feed needed. `days` is the SAME kind of raw day-count
 * range string marketData/backfill.ts's backfillDaily already sends Yahoo
 * (confirmed live: "3650d" resolves correctly, not just Yahoo's named
 * ranges like "10y").
 */
export async function backfillMacroIndicators(days: number): Promise<number> {
  let total = 0;
  for (const symbol of MACRO_SYMBOLS) {
    const bars = await fetchYahooChart(symbol, `${Math.max(days, 30)}d`, "1d");
    if (bars.length === 0) {
      logger.warn({ symbol }, "macro_indicator_backfill_empty");
      continue;
    }
    const rows = bars.map((bar) => ({ symbol, time: bar.time, value: bar.close.toString() }));
    await prisma.macroIndicator.createMany({ data: rows, skipDuplicates: true });
    logger.info({ symbol, rows: bars.length }, "macro_indicator_backfill_done");
    total += bars.length;
  }
  return total;
}

export interface LatestMacroReadings {
  tnx: Decimal | null;
  vix: Decimal | null;
  time: Date | null;
}

/** Most recent reading per symbol, regardless of how they individually resolved -- a stale VIX shouldn't hide a fresh 10Y or vice versa. */
export async function getLatestMacroReadings(): Promise<LatestMacroReadings> {
  const [tnxRow, vixRow] = await Promise.all([
    prisma.macroIndicator.findFirst({ where: { symbol: "^TNX" }, orderBy: { time: "desc" } }),
    prisma.macroIndicator.findFirst({ where: { symbol: "^VIX" }, orderBy: { time: "desc" } }),
  ]);
  const times = [tnxRow?.time, vixRow?.time].filter((t): t is Date => t !== undefined);
  return {
    tnx: tnxRow ? new Decimal(tnxRow.value.toString()) : null,
    vix: vixRow ? new Decimal(vixRow.value.toString()) : null,
    time: times.length > 0 ? new Date(Math.max(...times.map((t) => t.getTime()))) : null,
  };
}

export interface PreviousMacroReadings {
  tnx: Decimal | null;
  vix: Decimal | null;
}

/**
 * The reading immediately BEFORE the current latest one, per symbol --
 * daily bars upserted once per day (see refreshMacroIndicators), so this is
 * naturally "yesterday's close" rather than some arbitrary older row. Used
 * by the narrative report's WHAT HAPPENED section to describe a real
 * session-over-session delta (2026-08-11) instead of just a bare current
 * value. Null per-symbol when fewer than 2 readings exist yet.
 */
export async function getPreviousMacroReadings(): Promise<PreviousMacroReadings> {
  const [tnxRows, vixRows] = await Promise.all([
    prisma.macroIndicator.findMany({ where: { symbol: "^TNX" }, orderBy: { time: "desc" }, take: 2 }),
    prisma.macroIndicator.findMany({ where: { symbol: "^VIX" }, orderBy: { time: "desc" }, take: 2 }),
  ]);
  return {
    tnx: tnxRows.length > 1 ? new Decimal(tnxRows[1]!.value.toString()) : null,
    vix: vixRows.length > 1 ? new Decimal(vixRows[1]!.value.toString()) : null,
  };
}
