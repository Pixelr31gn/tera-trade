/**
 * Timeframe alignment gate (2026-11-02, operator request: "lets add a time
 * frame alignment gate"). A long needs price above the EMA(20) on every
 * timeframe below, a short needs it below on every one.
 *
 * 5m/15m/1h and EMA(20) are a first, hand-set choice: the request named no
 * timeframes, and these are the intraday ones built from bars_1m with the EMA
 * period analytics/intradayEmaProximity.ts already uses. Not validated -- the
 * closest evidence is scripts/backtestIntraday20v200Cross.ts (analytics/
 * emaTrend.ts), which found a different hard EMA direction gate flat or
 * negative. Append any retune here.
 *
 * Fails closed like the Tilt gate: too little history to read a timeframe
 * blocks the entry -- otherwise thin data would silently turn the rule off.
 *
 * 2026-11-11 (operator request: "time frame alignment should only need to
 * verify alignment, approve 1"): was all 3 timeframes must agree; now
 * ALIGNMENT_MIN_MATCHING = 1, i.e. at least one of 5m/15m/1h on the trade's
 * side of its EMA(20). Evidence at the time: 96 of ~98 consensus-cleared
 * longs in the 13:45-13:57 MST window were blocked here on a 5m/15m pullback
 * inside a 60m uptrend. Not harness-validated. Consequence worth knowing: when
 * the timeframes disagree, both a long and a short can now pass this gate.
 *
 * Pure: the caller passes the 1-minute bars.
 */
import { ema } from "../analytics/emaTrend.js";
import { aggregateBars } from "../analytics/intradayEmaProximity.js";
import type { OhlcBar } from "../regime/indicators.js";

export const ALIGNMENT_TIMEFRAMES_MINUTES = [5, 15, 60] as const;
export const ALIGNMENT_EMA_PERIOD = 20;
/** Timeframes that must be on the trade's side of their EMA (was all 3 until 2026-11-11). */
export const ALIGNMENT_MIN_MATCHING = 1;
/** 1-minute bars the caller should load: 30 hourly buckets, room for the 1h EMA(20) to settle. */
export const ALIGNMENT_LOOKBACK_BARS = 1800;

export interface TimeframeAlignmentCheck {
  allowed: boolean;
  reason: string;
}

export function checkTimeframeAlignment(bars: OhlcBar[], side: "long" | "short"): TimeframeAlignmentCheck {
  const reads: string[] = [];
  let matching = 0;
  for (const minutes of ALIGNMENT_TIMEFRAMES_MINUTES) {
    const closes = aggregateBars(bars, minutes).map((b) => b.close);
    if (closes.length < ALIGNMENT_EMA_PERIOD) {
      return { allowed: false, reason: `Timeframe alignment: only ${closes.length} ${minutes}m bars, need ${ALIGNMENT_EMA_PERIOD}` };
    }
    const emaValue = ema(closes, ALIGNMENT_EMA_PERIOD).at(-1)!;
    const lastClose = closes.at(-1)!;
    const matches = side === "long" ? lastClose > emaValue : lastClose < emaValue;
    if (matches) matching++;
    reads.push(`${minutes}m ${lastClose > emaValue ? "above" : lastClose < emaValue ? "below" : "at"} EMA${ALIGNMENT_EMA_PERIOD} ${emaValue.toFixed(2)}`);
  }
  const aligned = matching >= ALIGNMENT_MIN_MATCHING;
  return {
    allowed: aligned,
    reason: `Timeframe alignment: ${reads.join(", ")} -- ${matching}/${ALIGNMENT_TIMEFRAMES_MINUTES.length} agree (needs ${ALIGNMENT_MIN_MATCHING}), ${aligned ? "aligned" : "not aligned"} for ${side}`,
  };
}
