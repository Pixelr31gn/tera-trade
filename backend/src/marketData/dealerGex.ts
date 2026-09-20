/**
 * CBOE delayed-quotes ingestion for dealer gamma exposure (GEX) levels --
 * the free, public, no-auth JSON endpoint Matteo-Ferrara/gex-tracker uses
 * (confirmed live 2026-08-11: HTTP 200, per-contract gamma/open_interest
 * returned directly, no Black-Scholes recomputation needed).
 *
 * No options exist on the futures contracts themselves, so this maps each
 * traded future to its closest liquid CBOE-quoted index-options proxy: ES
 * -> SPX, NQ -> NDX. Confirmed live: NDX's current_price landed at ~29,646
 * at the same moment NQ itself was trading in the same range -- close
 * enough (small basis from dividends/financing) that the index chain's
 * strikes are directly usable as futures-price levels without correction.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import {
  computeGexByStrike,
  findGammaWalls,
  findGammaFlip,
  parseOccOptionSymbol,
  bucketOptionsByExpiration,
  type RawCboeOption,
  type ParsedOption,
  type DealerGexBucket,
} from "../analytics/dealerGex.js";
import { computeSupportResistanceLevels } from "../analytics/supportResistance.js";
import { atr as computeAtr, type OhlcBar } from "../regime/indicators.js";
import { classifySession, type TradingSession } from "../analytics/session.js";

const logger = childLogger("dealerGex");

const CBOE_TICKER_BY_SYMBOL: Record<string, string> = { ES: "SPX", NQ: "NDX" };

// Only near-dated expirations -- 0DTE-style walls dominate the levels an
// intraday futures desk actually cares about; a wall six months out is real
// but not "tonight's" gamma exposure. Hand-set, matches the report style
// this feature was modeled on (0DTE-focused). Unproven, watch results.
const MAX_EXPIRATION_DAYS_OUT = 7;

// Same cluster tolerance analytics/supportResistance.ts itself uses for
// "is this the same level" -- reused here for "does a GEX wall line up with
// a real price-action pivot," not a separately-invented number.
const CONFIRMATION_TOLERANCE_ATR_MULTIPLE = 0.5;

interface CboeChainResponse {
  data: {
    current_price: number;
    options: { option: string; open_interest: number; gamma: number }[];
  };
}

async function fetchCboeChain(cboeTicker: string): Promise<{ spotPrice: number; options: RawCboeOption[] }> {
  const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/_${cboeTicker}.json`);
  if (!res.ok) throw new Error(`CBOE fetch failed for ${cboeTicker}: HTTP ${res.status}`);
  const json = (await res.json()) as CboeChainResponse;
  return {
    spotPrice: json.data.current_price,
    options: json.data.options.map((o) => ({ symbol: o.option, openInterest: o.open_interest, gamma: o.gamma })),
  };
}

export interface DealerLevelResult {
  symbol: string;
  spotPrice: Decimal;
  callWall: Decimal | null;
  putWall: Decimal | null;
  gammaFlip: Decimal | null;
  /** Does the call wall also line up with a real price-action S/R pivot right now -- the "independent source agrees" signal. */
  callWallConfirmed: boolean;
  putWallConfirmed: boolean;
}

/**
 * Pure-ish orchestration (the one impure step is the CBOE fetch itself) --
 * takes recentBars so the price-action confirmation check can reuse
 * whatever bar window the caller already loaded, rather than fetching its
 * own.
 */
export async function computeDealerLevels(symbol: string, recentBars: OhlcBar[], at: Date): Promise<DealerLevelResult> {
  const cboeTicker = CBOE_TICKER_BY_SYMBOL[symbol];
  if (!cboeTicker) throw new Error(`No CBOE index-options proxy configured for ${symbol}`);

  const { spotPrice, options } = await fetchCboeChain(cboeTicker);

  const cutoff = new Date(at.getTime() + MAX_EXPIRATION_DAYS_OUT * 86_400_000);
  const parsed: { raw: RawCboeOption; parsed: ParsedOption }[] = [];
  for (const raw of options) {
    const p = parseOccOptionSymbol(raw.symbol);
    if (p && p.expiration <= cutoff) parsed.push({ raw, parsed: p });
  }

  const byStrike = computeGexByStrike(parsed, spotPrice);
  const { callWall, putWall } = findGammaWalls(byStrike);
  const gammaFlip = findGammaFlip(byStrike, spotPrice);

  const atrSeries = computeAtr(recentBars).filter((v) => !Number.isNaN(v));
  const atrValue = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1]! : 0;
  const srLevels = atrValue > 0 ? computeSupportResistanceLevels(recentBars, spotPrice, atrValue) : [];
  const confirmTolerance = atrValue * CONFIRMATION_TOLERANCE_ATR_MULTIPLE;

  const isConfirmed = (price: number | null): boolean =>
    price !== null && confirmTolerance > 0 && srLevels.some((sr) => Math.abs(sr.price - price) <= confirmTolerance);

  return {
    symbol,
    spotPrice: new Decimal(spotPrice),
    callWall: callWall !== null ? new Decimal(callWall) : null,
    putWall: putWall !== null ? new Decimal(putWall) : null,
    gammaFlip: gammaFlip !== null ? new Decimal(gammaFlip) : null,
    callWallConfirmed: isConfirmed(callWall),
    putWallConfirmed: isConfirmed(putWall),
  };
}

export async function computeAndPersistDealerLevels(symbol: string, recentBars: OhlcBar[], at: Date): Promise<DealerLevelResult> {
  const result = await computeDealerLevels(symbol, recentBars, at);
  const session = classifySession(at);
  await prisma.dealerGexLevel.create({
    data: {
      time: at,
      symbol,
      session,
      spotPrice: result.spotPrice.toString(),
      callWall: result.callWall?.toString(),
      putWall: result.putWall?.toString(),
      gammaFlip: result.gammaFlip?.toString(),
      callWallConfirmed: result.callWallConfirmed,
      putWallConfirmed: result.putWallConfirmed,
    },
  });
  logger.info(
    {
      symbol,
      session,
      spotPrice: result.spotPrice.toString(),
      callWall: result.callWall?.toString() ?? null,
      putWall: result.putWall?.toString() ?? null,
      gammaFlip: result.gammaFlip?.toString() ?? null,
      callWallConfirmed: result.callWallConfirmed,
      putWallConfirmed: result.putWallConfirmed,
    },
    "dealer_gex_computed"
  );
  return result;
}

export interface WallHistoricalStats {
  touches: number;
  rejected: number;
  broken: number;
}

/**
 * Real accumulated hold-rate for this symbol's wall shape, from
 * engine/dealerLevelOutcomeEvaluator.ts's own resolved outcomes -- not_reached
 * rows are excluded (a level price never came near says nothing about
 * whether it would have held). Used by analytics/dealerLevelReport.ts, which
 * reports "not enough history yet" below a minimum sample floor rather than
 * treating a thin sample as a real rate. `bucket` is required (not defaulted)
 * so a caller can't accidentally mix blended/0dte/structural samples into one
 * rate by forgetting it -- see DealerGexLevel.bucket's schema comment.
 */
export async function computeWallHistoricalStats(symbol: string, wallKind: "call_wall" | "put_wall", bucket: DealerGexBucket): Promise<WallHistoricalStats> {
  const rows =
    wallKind === "call_wall"
      ? await prisma.dealerGexLevel.findMany({ where: { symbol, bucket, callWallOutcome: { in: ["rejected", "broken"] } }, select: { callWallOutcome: true } })
      : await prisma.dealerGexLevel.findMany({ where: { symbol, bucket, putWallOutcome: { in: ["rejected", "broken"] } }, select: { putWallOutcome: true } });
  const outcomes = wallKind === "call_wall" ? rows.map((r) => (r as { callWallOutcome: string | null }).callWallOutcome) : rows.map((r) => (r as { putWallOutcome: string | null }).putWallOutcome);
  const rejected = outcomes.filter((o) => o === "rejected").length;
  const broken = outcomes.filter((o) => o === "broken").length;
  return { touches: rejected + broken, rejected, broken };
}

export interface BucketLevelResult {
  callWall: Decimal | null;
  putWall: Decimal | null;
  gammaFlip: Decimal | null;
  callWallConfirmed: boolean;
  putWallConfirmed: boolean;
}

export interface DealerLevelBucketedResult {
  symbol: string;
  spotPrice: Decimal;
  zeroDte: BucketLevelResult;
  structural: BucketLevelResult;
}

/**
 * Same CBOE chain/near-dated cutoff as computeDealerLevels above, split into
 * same-day (0DTE) vs. the 1-7-day-out remainder (structural) via
 * analytics/dealerGex.ts's bucketOptionsByExpiration, each independently run
 * through the identical wall/gamma-flip math -- report-only, additive.
 * Deliberately NOT sharing a fetch with computeDealerLevels: this makes a
 * second CBOE call per refresh cycle (free, unauthenticated endpoint, at
 * most once per 60s TTL per symbol -- see engine/dealerGexCache.ts), traded
 * for the guarantee that computeDealerLevels' own math/output/callers stay
 * byte-for-byte unchanged and nothing here can alter what feeds
 * risk/engine.ts's live proximity gate.
 */
export async function computeDealerLevelsBucketed(symbol: string, recentBars: OhlcBar[], at: Date): Promise<DealerLevelBucketedResult> {
  const cboeTicker = CBOE_TICKER_BY_SYMBOL[symbol];
  if (!cboeTicker) throw new Error(`No CBOE index-options proxy configured for ${symbol}`);

  const { spotPrice, options } = await fetchCboeChain(cboeTicker);

  const cutoff = new Date(at.getTime() + MAX_EXPIRATION_DAYS_OUT * 86_400_000);
  const parsed: { raw: RawCboeOption; parsed: ParsedOption }[] = [];
  for (const raw of options) {
    const p = parseOccOptionSymbol(raw.symbol);
    if (p && p.expiration <= cutoff) parsed.push({ raw, parsed: p });
  }
  const { zeroDte, structural } = bucketOptionsByExpiration(parsed, at);

  const atrSeries = computeAtr(recentBars).filter((v) => !Number.isNaN(v));
  const atrValue = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1]! : 0;
  const srLevels = atrValue > 0 ? computeSupportResistanceLevels(recentBars, spotPrice, atrValue) : [];
  const confirmTolerance = atrValue * CONFIRMATION_TOLERANCE_ATR_MULTIPLE;
  const isConfirmed = (price: number | null): boolean =>
    price !== null && confirmTolerance > 0 && srLevels.some((sr) => Math.abs(sr.price - price) <= confirmTolerance);

  const computeBucket = (bucketOptions: { raw: RawCboeOption; parsed: ParsedOption }[]): BucketLevelResult => {
    const byStrike = computeGexByStrike(bucketOptions, spotPrice);
    const { callWall, putWall } = findGammaWalls(byStrike);
    const gammaFlip = findGammaFlip(byStrike, spotPrice);
    return {
      callWall: callWall !== null ? new Decimal(callWall) : null,
      putWall: putWall !== null ? new Decimal(putWall) : null,
      gammaFlip: gammaFlip !== null ? new Decimal(gammaFlip) : null,
      callWallConfirmed: isConfirmed(callWall),
      putWallConfirmed: isConfirmed(putWall),
    };
  };

  return {
    symbol,
    spotPrice: new Decimal(spotPrice),
    zeroDte: computeBucket(zeroDte),
    structural: computeBucket(structural),
  };
}

export async function computeAndPersistDealerLevelsBucketed(symbol: string, recentBars: OhlcBar[], at: Date): Promise<DealerLevelBucketedResult> {
  const result = await computeDealerLevelsBucketed(symbol, recentBars, at);
  const session = classifySession(at);

  const rowData = (bucket: Extract<DealerGexBucket, "0dte" | "structural">, levels: BucketLevelResult) => ({
    time: at,
    symbol,
    session,
    bucket,
    spotPrice: result.spotPrice.toString(),
    callWall: levels.callWall?.toString(),
    putWall: levels.putWall?.toString(),
    gammaFlip: levels.gammaFlip?.toString(),
    callWallConfirmed: levels.callWallConfirmed,
    putWallConfirmed: levels.putWallConfirmed,
  });

  await prisma.dealerGexLevel.createMany({
    data: [rowData("0dte", result.zeroDte), rowData("structural", result.structural)],
  });

  logger.info(
    {
      symbol,
      session,
      spotPrice: result.spotPrice.toString(),
      zeroDteCallWall: result.zeroDte.callWall?.toString() ?? null,
      zeroDtePutWall: result.zeroDte.putWall?.toString() ?? null,
      structuralCallWall: result.structural.callWall?.toString() ?? null,
      structuralPutWall: result.structural.putWall?.toString() ?? null,
    },
    "dealer_gex_bucketed_computed"
  );
  return result;
}

export interface PreviousBucketSnapshotRow {
  time: Date;
  session: TradingSession;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
}

/**
 * Most recent snapshot for (symbol, bucket) strictly before `sessionStart`
 * -- i.e. from a genuinely earlier session, not just the prior 60s-cadence
 * tick within the same one. Used by engine/dealerLevelReportBuilder.ts's
 * WHAT HAPPENED / session-over-session sections. Null when this is the
 * first snapshot ever computed for this symbol/bucket.
 */
export async function getPreviousBucketSnapshot(symbol: string, bucket: DealerGexBucket, sessionStart: Date): Promise<PreviousBucketSnapshotRow | null> {
  const row = await prisma.dealerGexLevel.findFirst({
    where: { symbol, bucket, time: { lt: sessionStart } },
    orderBy: { time: "desc" },
  });
  if (!row) return null;
  return {
    time: row.time,
    session: row.session as TradingSession,
    callWall: row.callWall ? Number(row.callWall.toString()) : null,
    putWall: row.putWall ? Number(row.putWall.toString()) : null,
    gammaFlip: row.gammaFlip ? Number(row.gammaFlip.toString()) : null,
  };
}

