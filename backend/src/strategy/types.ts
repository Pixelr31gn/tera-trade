/**
 * Pluggable strategy interface.
 *
 * A Strategy only proposes candidate setups from price action -- it never
 * sizes, never places orders, and never sees news/regime data directly
 * (those are scored and risk-gated afterward). This keeps "what pattern
 * fired" cleanly separated from "should we trade it and how big."
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";

export interface Signal {
  strategyId: string;
  symbol: string;
  side: "long" | "short";
  structureSwingPrice: Decimal;
  reason: string;
}

export interface Strategy {
  strategyId: string;
  /** `bars` is ascending OHLCV history ending at the current (just-closed) bar. */
  generateSignal(symbol: string, bars: OhlcBar[]): Signal | null;
}
