/**
 * Assembles analytics/dealerLevelReport.ts's narrative from real, currently
 * available data -- the composition layer between the pure report template
 * and every I/O source it draws from (dealer_gex_levels, bars, macro
 * indicators). Mirrors engine/loop.ts's own role of gluing pure modules
 * together with DB/wall-clock-coupled lookups.
 *
 * Rewritten 2026-08-11 (same-day follow-up) to feed the restructured,
 * 0DTE/structural-bucketed report -- reads the report-only bucketed rows
 * (marketData/dealerGex.ts's computeAndPersistDealerLevelsBucketed, written
 * by engine/dealerGexCache.ts's getDealerLevelsBucketed) rather than the
 * "blended" row that still feeds the live risk gate untouched.
 */
import { prisma } from "../db/client.js";
import { loadRecentBars } from "./bootstrap.js";
import { classifyRegime } from "../regime/classifier.js";
import { atr as computeAtr } from "../regime/indicators.js";
import { classifySession, getSessionStart, type TradingSession } from "../analytics/session.js";
import { computeWallHistoricalStats, getPreviousBucketSnapshot } from "../marketData/dealerGex.js";
import { getLatestMacroReadings, getPreviousMacroReadings } from "../marketData/macroIndicators.js";
import { generateDealerLevelReport, type DealerLevelReportInput, type BucketSnapshot } from "../analytics/dealerLevelReport.js";

function toBucketSnapshot(row: { callWall: unknown; putWall: unknown; gammaFlip: unknown; callWallConfirmed: boolean; putWallConfirmed: boolean } | null): BucketSnapshot {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number((v as { toString(): string }).toString()));
  return {
    callWall: row ? num(row.callWall) : null,
    putWall: row ? num(row.putWall) : null,
    gammaFlip: row ? num(row.gammaFlip) : null,
    callWallConfirmed: row?.callWallConfirmed ?? false,
    putWallConfirmed: row?.putWallConfirmed ?? false,
  };
}

/** Returns null when no 0DTE/structural dealer-GEX snapshot has ever been computed for this symbol yet. */
export async function buildDealerLevelReport(symbol: string): Promise<string | null> {
  const [zeroDteRow, structuralRow] = await Promise.all([
    prisma.dealerGexLevel.findFirst({ where: { symbol, bucket: "0dte" }, orderBy: { time: "desc" } }),
    prisma.dealerGexLevel.findFirst({ where: { symbol, bucket: "structural" }, orderBy: { time: "desc" } }),
  ]);
  const latestRow = zeroDteRow ?? structuralRow;
  if (!latestRow) return null;

  const session = latestRow.session as TradingSession;
  const time = latestRow.time;
  const spotPrice = Number(latestRow.spotPrice.toString());
  const sessionStart = getSessionStart(time);

  const bars = await loadRecentBars(symbol, 300);
  const regime = bars.length > 0 ? classifyRegime(bars) : null;
  const atrSeries = bars.length > 0 ? computeAtr(bars).filter((v) => !Number.isNaN(v)) : [];
  const atrValue = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1]! : null;

  const [
    previousZeroDteRow,
    previousStructuralRow,
    zeroDteCallWallHistory,
    zeroDtePutWallHistory,
    structuralCallWallHistory,
    structuralPutWallHistory,
    macro,
    previousMacro,
  ] = await Promise.all([
    getPreviousBucketSnapshot(symbol, "0dte", sessionStart),
    getPreviousBucketSnapshot(symbol, "structural", sessionStart),
    computeWallHistoricalStats(symbol, "call_wall", "0dte"),
    computeWallHistoricalStats(symbol, "put_wall", "0dte"),
    computeWallHistoricalStats(symbol, "call_wall", "structural"),
    computeWallHistoricalStats(symbol, "put_wall", "structural"),
    getLatestMacroReadings(),
    getPreviousMacroReadings(),
  ]);

  const input: DealerLevelReportInput = {
    symbol,
    session,
    time,
    spotPrice,
    atrValue,

    zeroDte: toBucketSnapshot(zeroDteRow),
    structural: toBucketSnapshot(structuralRow),
    previousZeroDte: previousZeroDteRow,
    previousStructural: previousStructuralRow,

    zeroDteCallWallHistory,
    zeroDtePutWallHistory,
    structuralCallWallHistory,
    structuralPutWallHistory,

    trendLabel: regime?.trendLabel ?? "none",
    volLabel: regime?.volLabel ?? "normal",

    tenYearYield: macro.tnx ? macro.tnx.toNumber() : null,
    vix: macro.vix ? macro.vix.toNumber() : null,
    macroReadingTime: macro.time,
    previousTenYearYield: previousMacro.tnx ? previousMacro.tnx.toNumber() : null,
    previousVix: previousMacro.vix ? previousMacro.vix.toNumber() : null,
  };

  return generateDealerLevelReport(input);
}
