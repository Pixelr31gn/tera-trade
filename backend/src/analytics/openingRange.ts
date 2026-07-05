/**
 * Opening Range Breakout statistics: empirically, how often does price break
 * above/below the first hour's high/low later in the same session?
 *
 * This is a genuine backtest over historical bars -- the probabilities it
 * returns are observed frequencies, not a hand-tuned heuristic weight, which
 * is the point: it's meant to give the scoring engine (and the dashboard) a
 * number backed by actual price-action history for this specific instrument.
 */
import type { OhlcBar } from "../regime/indicators.js";

export interface OpeningRangeStats {
  symbol: string;
  sessionsAnalyzed: number;
  probHighBroken: number | null;
  probLowBroken: number | null;
  probBothBroken: number | null;
  probNeitherBroken: number | null;
}

interface SessionBars {
  sessionDate: string; // YYYY-MM-DD in ET, used only as a grouping key
  bars: OhlcBar[];
}

/** Formats a bar's timestamp as ET wall-clock {date, hour, minute} without needing a date library -- DST-aware via Intl. */
function easternWallClock(time: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(time);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
}

/** Groups ascending-time bars by their US/Eastern calendar date. */
function groupBySessionDate(bars: OhlcBar[]): SessionBars[] {
  const sessions = new Map<string, OhlcBar[]>();
  for (const bar of bars) {
    const { date } = easternWallClock(bar.time);
    if (!sessions.has(date)) sessions.set(date, []);
    sessions.get(date)!.push(bar);
  }
  return [...sessions.entries()].map(([sessionDate, sessionBars]) => ({ sessionDate, bars: sessionBars }));
}

const RTH_CLOSE_HOUR_ET = 16; // 4:00pm ET -- covers all four Phase-0 instruments' RTH sessions with margin

/**
 * For each session day present in `bars`, splits that day's bars into the
 * "opening range" (the first `openRangeMinutes` after `rthOpenHourET:rthOpenMinuteET`)
 * and the rest of the RTH session, then checks whether the later session's
 * high/low broke outside the opening range.
 */
export function computeOpeningRangeStats(
  bars: OhlcBar[],
  symbol: string,
  rthOpenHourET: number,
  rthOpenMinuteET: number,
  openRangeMinutes = 60
): OpeningRangeStats {
  const sessions = groupBySessionDate(bars);
  const openMinutesOfDay = rthOpenHourET * 60 + rthOpenMinuteET;

  let sessionsAnalyzed = 0;
  let highBroken = 0;
  let lowBroken = 0;
  let bothBroken = 0;
  let neitherBroken = 0;

  for (const session of sessions) {
    const openingRangeBars: OhlcBar[] = [];
    const laterBars: OhlcBar[] = [];

    for (const bar of session.bars) {
      const { hour, minute } = easternWallClock(bar.time);
      const minutesOfDay = hour * 60 + minute;
      if (minutesOfDay < openMinutesOfDay || hour >= RTH_CLOSE_HOUR_ET) continue; // outside RTH entirely
      if (minutesOfDay < openMinutesOfDay + openRangeMinutes) {
        openingRangeBars.push(bar);
      } else {
        laterBars.push(bar);
      }
    }

    if (openingRangeBars.length === 0 || laterBars.length === 0) continue; // incomplete/partial session -- skip, don't guess

    const openingHigh = Math.max(...openingRangeBars.map((b) => b.high));
    const openingLow = Math.min(...openingRangeBars.map((b) => b.low));
    const laterHigh = Math.max(...laterBars.map((b) => b.high));
    const laterLow = Math.min(...laterBars.map((b) => b.low));

    const didBreakHigh = laterHigh > openingHigh;
    const didBreakLow = laterLow < openingLow;

    sessionsAnalyzed++;
    if (didBreakHigh) highBroken++;
    if (didBreakLow) lowBroken++;
    if (didBreakHigh && didBreakLow) bothBroken++;
    if (!didBreakHigh && !didBreakLow) neitherBroken++;
  }

  if (sessionsAnalyzed === 0) {
    return { symbol, sessionsAnalyzed: 0, probHighBroken: null, probLowBroken: null, probBothBroken: null, probNeitherBroken: null };
  }

  return {
    symbol,
    sessionsAnalyzed,
    probHighBroken: highBroken / sessionsAnalyzed,
    probLowBroken: lowBroken / sessionsAnalyzed,
    probBothBroken: bothBroken / sessionsAnalyzed,
    probNeitherBroken: neitherBroken / sessionsAnalyzed,
  };
}
