/**
 * Human-readable market structure / liquidity / price-action descriptors,
 * derived from data the regime classifier and bar history already compute.
 * These exist so the trade dataset records *why* a setup looked the way it
 * did in plain terms an analyst (or the adaptive optimizer) can group by,
 * not just raw numbers.
 */
import type { RegimeResult } from "../regime/classifier.js";
import type { OhlcBar } from "../regime/indicators.js";
import type { TradingSession } from "./session.js";

export type MarketStructureLabel = "strong_uptrend" | "weak_uptrend" | "ranging" | "weak_downtrend" | "strong_downtrend";

export function classifyMarketStructure(regime: RegimeResult): MarketStructureLabel {
  const adx = regime.features.adx ?? 0;
  if (regime.trendLabel === "none") return "ranging";
  const strong = adx >= 35;
  if (regime.trendLabel === "up") return strong ? "strong_uptrend" : "weak_uptrend";
  return strong ? "strong_downtrend" : "weak_downtrend";
}

export type LiquidityLabel = "high" | "normal" | "low";

/**
 * Liquidity has no direct feed here (no order book depth), so this combines
 * two real proxies: the session (NY/London are structurally higher-liquidity
 * for CME index/energy/metals futures than the Asian session) and observed
 * relative volume, when available.
 */
export function classifyLiquidity(volumeZscore: number | null, session: TradingSession): LiquidityLabel {
  if (volumeZscore !== null) {
    if (volumeZscore >= 1) return "high";
    if (volumeZscore <= -1) return "low";
  }
  return session === "asian" ? "low" : "normal";
}

export type PriceActionLabel =
  | "strong_bullish_body"
  | "strong_bearish_body"
  | "upper_wick_rejection"
  | "lower_wick_rejection"
  | "indecision_doji"
  | "normal";

/** Describes the most recent bar's candle shape -- body dominance vs. wick rejection vs. indecision. */
export function describePriceAction(bars: OhlcBar[]): PriceActionLabel {
  const last = bars[bars.length - 1];
  if (!last) return "normal";

  const range = last.high - last.low;
  if (range <= 0) return "normal";

  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  if (bodyRatio <= 0.15) return "indecision_doji";
  if (bodyRatio >= 0.7) return last.close >= last.open ? "strong_bullish_body" : "strong_bearish_body";
  if (upperWick > body * 1.5 && upperWick > lowerWick) return "upper_wick_rejection";
  if (lowerWick > body * 1.5 && lowerWick > upperWick) return "lower_wick_rejection";
  return "normal";
}
