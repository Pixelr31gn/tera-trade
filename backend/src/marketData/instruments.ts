/**
 * Reference instrument definitions for the Phase-0 futures universe.
 *
 * `dataSymbol` is the Yahoo Finance continuous-contract ticker used for free
 * historical/live backfill. `contractId` is left unset until the user has a
 * ProjectX Gateway account and can resolve the live front-month contract via
 * POST /api/Contract/searchById.
 */
import { Decimal } from "decimal.js";

export interface InstrumentSpec {
  symbol: string; // canonical Tera Trade symbol, e.g. "ES"
  dataSymbol: string; // Yahoo Finance ticker, e.g. "ES=F"
  exchange: string;
  tickSize: Decimal;
  pointValue: Decimal;
  /** Regular trading hours open, in US Eastern local wall-clock time (DST-aware via Intl). */
  rthOpenHourET: number;
  rthOpenMinuteET: number;
  /**
   * CME contract-code prefix actually configured on the account for browser-driven
   * order placement (see brokers/browserControlBroker.ts), e.g. "MNQ" for Micro
   * E-mini Nasdaq. Micro contracts share the exact same underlying price series
   * as their full-size counterparts (same tick size, same Yahoo feed) -- only
   * the multiplier (pointValue) and the real order-entry contract differ, which
   * is why this is a separate field rather than changing `symbol`/`dataSymbol`
   * (that would orphan all historical bars/scores/trades already keyed by the
   * full-size symbol).
   */
  brokerContractPrefix: string;
  /**
   * Largest gap, in price POINTS, between a market order's theoretical price and a
   * fill price scraped back off the broker's DOM that is still believable as real
   * slippage rather than a misread (see brokers/browserControlBroker.ts's
   * readRealFillPrice). Beyond this the reading is discarded and the theoretical
   * price is used instead.
   *
   * 2026-09-21: replaces a flat 5% RELATIVE guard that was inert on a five-figure
   * index -- 5% of NQ at 30,000 is +/-1500 points, so every misread this guard
   * existed to catch sailed straight through it. Confirmed live the same day:
   * readings 22.25, 24.50 and 64.00 points off the real fill were all accepted as
   * genuine, and execution/engine.ts then anchored the stop and target to them,
   * putting both on the wrong side of entry for a long (trades 5, 10 and 12) so the
   * standalone take-profit LIMIT was immediately fillable and closed the position
   * seconds after it opened.
   *
   * Set per instrument rather than derived from tickSize: tick size does not scale
   * with how far an instrument genuinely moves (ES and NQ share a 0.25 tick but NQ
   * ranges roughly 4x as far in points), so a tick multiple would be simultaneously
   * too tight on NQ and too loose on CL. Sized generously -- a few times normal
   * micro-contract slippage, so a fast-market fill is never thrown away -- while
   * staying well under the smallest misread observed above.
   */
  maxFillDeviationPoints: Decimal;
  /**
   * Band, in TICKS, that this instrument's real broker-side trailing-stop
   * distance is clamped into (see risk/stops.ts's
   * resolveTrailingStopDistanceTicks, which takes a fraction of current ATR
   * and clamps it here). Absent = keep the flat
   * risk/stops.ts TRAILING_STOP_DISTANCE_TICKS that every instrument used
   * before 2026-09-21.
   *
   * Only NQ has one so far, per operator instruction that day ("the trailing
   * stop loss is way too tight for nq it should be at 20 ticks to 35 at the
   * least never less than 15"). The flat 5 ticks it replaces is 1.25 points
   * on NQ -- narrower than routine two-way noise, which is why nearly every
   * NQ trade that armed a trail that session was closed by it within
   * moments. ES/GC/CL are very likely mis-served by a flat 5 too, but their
   * right numbers have not been specified, and guessing at a live risk
   * parameter is worse than leaving a known-conservative one in place.
   */
  trailingStopTickBand?: { minTicks: number; maxTicks: number };
}

export const DEFAULT_INSTRUMENTS: InstrumentSpec[] = [
  { symbol: "ES", dataSymbol: "ES=F", exchange: "CME", tickSize: new Decimal("0.25"), pointValue: new Decimal(5), rthOpenHourET: 9, rthOpenMinuteET: 30, brokerContractPrefix: "MES", maxFillDeviationPoints: new Decimal("3") },
  { symbol: "NQ", dataSymbol: "NQ=F", exchange: "CME", tickSize: new Decimal("0.25"), pointValue: new Decimal(2), rthOpenHourET: 9, rthOpenMinuteET: 30, brokerContractPrefix: "MNQ", maxFillDeviationPoints: new Decimal("10"), trailingStopTickBand: { minTicks: 20, maxTicks: 35 } },
  { symbol: "CL", dataSymbol: "CL=F", exchange: "NYMEX", tickSize: new Decimal("0.01"), pointValue: new Decimal(100), rthOpenHourET: 9, rthOpenMinuteET: 0, brokerContractPrefix: "MCL", maxFillDeviationPoints: new Decimal("0.15") },
  { symbol: "GC", dataSymbol: "GC=F", exchange: "COMEX", tickSize: new Decimal("0.10"), pointValue: new Decimal(10), rthOpenHourET: 8, rthOpenMinuteET: 20, brokerContractPrefix: "MGC", maxFillDeviationPoints: new Decimal("2") },
];

const bySymbol = new Map(DEFAULT_INSTRUMENTS.map((i) => [i.symbol, i]));

export function getInstrument(symbol: string): InstrumentSpec {
  const spec = bySymbol.get(symbol);
  if (!spec) throw new Error(`Unknown instrument symbol: ${symbol}`);
  return spec;
}

// The subset actually traded, per the user -- CL and GC are excluded from
// every *recurring* background job (browser-tick collection, continuous
// scoring, backfill, rollups) so no compute/DB writes are spent analyzing
// symbols nobody trades. DEFAULT_INSTRUMENTS itself is untouched and every
// excluded symbol's existing historical data stays queryable -- on-demand/
// read-only endpoints (market snapshot, performance history, regime display)
// still use the full list so past data remains visible if anyone looks it up.
// (2026-07-15: narrowed to NQ only -- "I don't trade ES". 2026-07-20:
// re-added ES. 2026-09-03: re-added GC, traded as MGC -- its pointValue (10)
// and brokerContractPrefix (MGC) above were already sized for the micro
// contract, same pattern as ES/NQ's MES/MNQ, so no economics changed here.
// Added disabled-by-default via DisabledSymbol (see
// engine/symbolEnablementCache.ts and the new per-instrument dashboard
// toggle) -- MGC's order-entry DOM automation has never been exercised
// against the real account, unlike MES/MNQ's, which were calibrated live
// (see docs/BUILD_HISTORY.md). Flip it on from the dashboard once verified.)
export const ACTIVE_INSTRUMENTS: InstrumentSpec[] = DEFAULT_INSTRUMENTS.filter((i) => i.symbol === "NQ" || i.symbol === "ES" || i.symbol === "GC");

// ES/NQ cross-symbol conflict check (2026-09-01, operator request: "ES and
// NQ should never enter into conflicting trades"). Both are broad US equity
// index futures, ~90%+ correlated intraday -- a long on one held alongside a
// short on the other isn't diversification, it's betting against yourself on
// the same underlying move. Confirmed live the same day: NQ long open
// simultaneously with ES short (trades #177/#178/#179), and earlier the same
// session (#151 ES short overlapping #170 NQ long). A plain symbol->symbol
// map, not a general "correlation group" concept -- CL/GC aren't currently
// traded (see ACTIVE_INSTRUMENTS above) and aren't meaningfully correlated
// with ES/NQ or each other anyway, so there's nothing to generalize to yet.
const CONFLICTING_PARTNER_SYMBOL: Partial<Record<string, string>> = { ES: "NQ", NQ: "ES" };

/** The symbol whose opposite-direction open position would conflict with a new trade on `symbol` -- null for any symbol with no defined partner (see CONFLICTING_PARTNER_SYMBOL above). */
export function getConflictingPartnerSymbol(symbol: string): string | null {
  return CONFLICTING_PARTNER_SYMBOL[symbol] ?? null;
}
