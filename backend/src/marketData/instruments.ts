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
}

export const DEFAULT_INSTRUMENTS: InstrumentSpec[] = [
  { symbol: "ES", dataSymbol: "ES=F", exchange: "CME", tickSize: new Decimal("0.25"), pointValue: new Decimal(5), rthOpenHourET: 9, rthOpenMinuteET: 30, brokerContractPrefix: "MES" },
  { symbol: "NQ", dataSymbol: "NQ=F", exchange: "CME", tickSize: new Decimal("0.25"), pointValue: new Decimal(2), rthOpenHourET: 9, rthOpenMinuteET: 30, brokerContractPrefix: "MNQ" },
  { symbol: "CL", dataSymbol: "CL=F", exchange: "NYMEX", tickSize: new Decimal("0.01"), pointValue: new Decimal(100), rthOpenHourET: 9, rthOpenMinuteET: 0, brokerContractPrefix: "MCL" },
  { symbol: "GC", dataSymbol: "GC=F", exchange: "COMEX", tickSize: new Decimal("0.10"), pointValue: new Decimal(10), rthOpenHourET: 8, rthOpenMinuteET: 20, brokerContractPrefix: "MGC" },
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
// re-added ES.)
export const ACTIVE_INSTRUMENTS: InstrumentSpec[] = DEFAULT_INSTRUMENTS.filter((i) => i.symbol === "NQ" || i.symbol === "ES");
