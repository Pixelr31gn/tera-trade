/**
 * Access to the still-forming 1-minute bar for the continuous scan
 * (2026-10-12, operator: "why are recommendations happening every minute
 * instead of every 15 seconds").
 *
 * Completed bars are written to the DB only when their minute ends, so a
 * 15-second scan that reads bars from the DB saw the same last bar for a whole
 * minute and scored once a minute. index.ts registers the MinuteBarAggregator
 * here; scanSymbolContinuously appends the forming bar to what it loaded, so
 * every scan scores the current price. Null source (tests, non-browser price
 * feeds) means "no forming bar" -- the scan behaves exactly as before.
 */
import type { OhlcBar } from "../regime/indicators.js";
import type { AggregatedMinuteBar } from "../marketData/minuteBarAggregator.js";

type FormingBarSource = (symbol: string) => AggregatedMinuteBar | null;
let source: FormingBarSource | null = null;

export function setFormingBarSource(fn: FormingBarSource | null): void {
  source = fn;
}

/** `bars` (oldest first) with the forming minute appended when it is newer than the last completed bar. */
export function withFormingBar(symbol: string, bars: OhlcBar[]): OhlcBar[] {
  const forming = source?.(symbol);
  if (!forming) return bars;
  const last = bars.at(-1);
  if (last && forming.time.getTime() <= last.time.getTime()) return bars;
  return [
    ...bars,
    {
      time: forming.time,
      open: forming.open.toNumber(),
      high: forming.high.toNumber(),
      low: forming.low.toNumber(),
      close: forming.close.toNumber(),
      volume: forming.volume.toNumber(),
    },
  ];
}
