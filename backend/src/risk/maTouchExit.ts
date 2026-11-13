/**
 * 20 MA touch exit (2026-11-13, operator request). After a valid entry,
 * close the position as soon as price comes within MA_TOUCH_EXIT_TICKS of
 * the 20 MA on any WATCHED timeframe -- longs and shorts alike.
 *
 * Which timeframes are watched (operator, same day): every timeframe whose
 * 20 MA was NOT already within the distance at entry -- "if 15 ma was in
 * distance and the 1 min ma was in distance at the time the only one that
 * can close is if the 5 min 30 min and hour". An MA that already sat next to
 * price at entry would otherwise close the trade the instant it opened.
 * "Near at entry" uses this exit's own distance (NQ 50, not the entry gate's
 * 45), so an MA between 45 and 50 ticks at entry can't fire immediately
 * either. A timeframe with no MA at entry (too little history) isn't watched.
 *
 * Distance (operator's "50 to 15 ticks", clarified same day: per symbol,
 * NQ 50, ES 15). The 20 is a simple MA, same as emaProximityGate.ts.
 *
 * Evidence: none tested -- operator's rule and numbers, unvalidated. Append
 * any retune here.
 */
import { computeTimeframeSmas, EMA_PROXIMITY_PERIOD, MULTI_TF_MA_MINUTES } from "./emaProximityGate.js";
import type { OhlcBar } from "../regime/indicators.js";

export const MA_TOUCH_EXIT_PERIOD = EMA_PROXIMITY_PERIOD; // 20
/** Candidate timeframes, in minutes. Those near at entry are dropped per trade. */
export const MA_TOUCH_EXIT_MINUTES: readonly number[] = MULTI_TF_MA_MINUTES;
export const MA_TOUCH_EXIT_TICKS = 15;
export const MA_TOUCH_EXIT_TICKS_BY_SYMBOL: Readonly<Record<string, number>> = { NQ: 50, ES: 15 };
export function maTouchExitTicksFor(symbol: string): number {
  return MA_TOUCH_EXIT_TICKS_BY_SYMBOL[symbol] ?? MA_TOUCH_EXIT_TICKS;
}

/** Ticks between a price range [low, high] and a level: 0 if the range covers it. */
function ticksAway(low: number, high: number, level: number, tickSize: number): number {
  if (level >= low && level <= high) return 0;
  return Math.min(Math.abs(high - level), Math.abs(low - level)) / tickSize;
}

/** Timeframes to watch for this trade: 20 MA computable at entry and NOT within `maxTicks` of the entry price. */
export function watchedTimeframesAtEntry(
  barsBeforeEntry: OhlcBar[],
  entryPrice: number,
  tickSize: number,
  maxTicks: number,
  minutes: readonly number[] = MA_TOUCH_EXIT_MINUTES,
  period: number = MA_TOUCH_EXIT_PERIOD,
): number[] {
  return computeTimeframeSmas(barsBeforeEntry, period)
    .filter((t) => minutes.includes(t.minutes) && t.ma !== null && ticksAway(entryPrice, entryPrice, t.ma, tickSize) > maxTicks + 1e-9)
    .map((t) => t.minutes);
}

export interface MaTouchExitCheck {
  fire: boolean;
  minutes: number | null;
  ma: number | null;
  ticks: number | null;
  reason: string;
}

/** Does the current price range [low, high] come within `maxTicks` of the 20 MA on any watched timeframe? */
export function checkMaTouchExit(
  bars: OhlcBar[],
  low: number,
  high: number,
  tickSize: number,
  maxTicks: number,
  watched: readonly number[],
  period: number = MA_TOUCH_EXIT_PERIOD,
): MaTouchExitCheck {
  if (watched.length === 0) return { fire: false, minutes: null, ma: null, ticks: null, reason: "20 MA exit: no watched timeframes" };
  for (const t of computeTimeframeSmas(bars, period)) {
    if (!watched.includes(t.minutes) || t.ma === null) continue;
    const ticks = ticksAway(low, high, t.ma, tickSize);
    if (ticks <= maxTicks + 1e-9) {
      const tf = t.minutes === 60 ? "1h" : `${t.minutes}m`;
      return { fire: true, minutes: t.minutes, ma: t.ma, ticks, reason: `20 MA exit: price within ${ticks.toFixed(0)} ticks of the ${tf} 20 MA ${t.ma.toFixed(2)} (limit ${maxTicks})` };
    }
  }
  return { fire: false, minutes: null, ma: null, ticks: null, reason: "20 MA exit: no watched MA within range" };
}
