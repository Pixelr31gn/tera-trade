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
  // "breakout" (price just cleared a prior high/low -- the risk engine's
  // level-proximity gate must check the *broken* level, not search for an
  // unrelated nearby level in the strategy's trade direction) vs "reversal"
  // (a bounce/fade trade, where "enter near support for a long" is the
  // correct check). See risk/engine.ts's gate for why this distinction
  // exists -- conflating the two was rejecting valid, strengthening
  // breakouts because they kept moving further from an irrelevant,
  // single-touch pivot instead of the level they actually broke.
  signalKind: "breakout" | "reversal";
  // Only set when signalKind is "breakout": the actual prior high/low this
  // signal broke through, used to validate the break is against a real,
  // multiply-tested level rather than an arbitrary swing point.
  breakoutLevelPrice?: Decimal;
}

export interface Strategy {
  strategyId: string;
  /** `bars` is ascending OHLCV history ending at the current (just-closed) bar. */
  generateSignal(symbol: string, bars: OhlcBar[]): Signal | null;
}
