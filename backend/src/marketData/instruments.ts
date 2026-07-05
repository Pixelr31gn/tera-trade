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
}

export const DEFAULT_INSTRUMENTS: InstrumentSpec[] = [
  { symbol: "ES", dataSymbol: "ES=F", exchange: "CME", tickSize: new Decimal("0.25"), pointValue: new Decimal(50), rthOpenHourET: 9, rthOpenMinuteET: 30 },
  { symbol: "NQ", dataSymbol: "NQ=F", exchange: "CME", tickSize: new Decimal("0.25"), pointValue: new Decimal(20), rthOpenHourET: 9, rthOpenMinuteET: 30 },
  { symbol: "CL", dataSymbol: "CL=F", exchange: "NYMEX", tickSize: new Decimal("0.01"), pointValue: new Decimal(1000), rthOpenHourET: 9, rthOpenMinuteET: 0 },
  { symbol: "GC", dataSymbol: "GC=F", exchange: "COMEX", tickSize: new Decimal("0.10"), pointValue: new Decimal(100), rthOpenHourET: 8, rthOpenMinuteET: 20 },
];

const bySymbol = new Map(DEFAULT_INSTRUMENTS.map((i) => [i.symbol, i]));

export function getInstrument(symbol: string): InstrumentSpec {
  const spec = bySymbol.get(symbol);
  if (!spec) throw new Error(`Unknown instrument symbol: ${symbol}`);
  return spec;
}
