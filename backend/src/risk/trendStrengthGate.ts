/**
 * Trend-strength entry gate (2026-11-08, operator request: "implement entry
 * and exit rules for high probability executions", choosing to go live
 * unvalidated). Allows an entry only when the intraday regime shows a strong
 * trend: ADX at or above TREND_STRENGTH_MIN_ADX, or a strong trend structure
 * in the trade's own direction (analytics/priceAction.ts's
 * classifyMarketStructure: trend label matching the side with ADX >= 35).
 *
 * Evidence at the time, from the 2026-11-08 analysis (scored-signal outcomes,
 * 1 signal per symbol per 5 min, NQ, 11 trading days, 3R simulated exits, no
 * costs, standard errors clustered by day): longs with ADX 40+ averaged
 * +0.39R +/- 0.28 (n=187) and strong-uptrend structure +0.37R +/- 0.40
 * (n=99), against -0.03R +/- 0.23 for all longs. Both under 1.5 standard
 * errors -- a hypothesis, not a validated edge. Applied to shorts by mirror
 * image (strong downtrend), which the analysis did not test separately.
 * Append any retune here.
 *
 * 2026-11-09: 40 -> 20 (operator request: "lower the trend gate"). Evidence:
 * from 09:14 to 12:40 MST that day it blocked all 7 signals that cleared
 * every other entry gate (NQ longs, ADX 16.3-25.9, structure "ranging") --
 * price within 15 ticks of the 5m EMA20 is a pullback, and ADX is low there,
 * so at 40 the gate and the 20 MA gate almost never passed together. 20 is
 * a judgment call, not a tested number; 2 of those 7 (ADX 20.1, 25.9) would
 * have passed. Side effect: ADX has no direction, and at 20 the
 * strong-structure branch (ADX >= 35) is now always covered by the ADX
 * branch, so the gate no longer distinguishes a trend with the trade from
 * one against it -- the timeframe alignment gate still does that.
 *
 * Pure: the caller passes the regime already computed for this decision.
 */
import { classifyMarketStructure } from "../analytics/priceAction.js";
import type { RegimeResult } from "../regime/classifier.js";

export const TREND_STRENGTH_MIN_ADX = 20;

export interface TrendStrengthCheck {
  allowed: boolean;
  reason: string;
}

export function checkTrendStrength(regime: RegimeResult, side: "long" | "short"): TrendStrengthCheck {
  const adx = regime.features.adx ?? null;
  const structure = classifyMarketStructure(regime);
  const adxText = adx === null ? "no ADX reading" : `ADX ${adx.toFixed(1)}`;
  const strongAdx = adx !== null && adx >= TREND_STRENGTH_MIN_ADX;
  const strongWithTrade = structure === (side === "long" ? "strong_uptrend" : "strong_downtrend");
  const allowed = strongAdx || strongWithTrade;
  return {
    allowed,
    reason: `Trend strength: ${adxText}, structure ${structure} -- ${allowed ? "strong enough" : `needs ADX ${TREND_STRENGTH_MIN_ADX}+ or a strong ${side === "long" ? "up" : "down"}trend`} for ${side}`,
  };
}
