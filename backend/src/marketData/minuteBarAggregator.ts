/**
 * Aggregates raw price ticks (every ~5-10s from the browser watcher) into
 * real 1-minute OHLCV bars, in memory, per symbol.
 *
 * Without this, bars_1m was really storing one degenerate zero-range row
 * (open=high=low=close) per tick -- ATR/regime/Donchian-channel/support-
 * resistance calculations all silently treated "the last 20 rows" as 20
 * minutes when it was actually 100-200 seconds of noise. That's why the
 * real win rate was 19% with a median trade duration of 25 seconds:
 * breakout_donchian_20 was trading tick-level wiggles, not real breakouts.
 */
import { Decimal } from "decimal.js";

export interface AggregatedMinuteBar {
  time: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

interface InProgressBar {
  minuteKey: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export class MinuteBarAggregator {
  private current = new Map<string, InProgressBar>();

  /**
   * Feeds one price tick for `symbol`. Returns the just-completed previous
   * minute's bar if this tick belongs to a new minute (so the caller can
   * persist it and trigger signal evaluation), or null if it's just
   * updating the still-forming current minute.
   */
  addTick(symbol: string, price: Decimal, volume: Decimal, at: Date): AggregatedMinuteBar | null {
    const minuteKey = Math.floor(at.getTime() / 60_000) * 60_000;
    const existing = this.current.get(symbol);

    if (!existing || existing.minuteKey !== minuteKey) {
      const completed: AggregatedMinuteBar | null = existing
        ? { time: new Date(existing.minuteKey), open: existing.open, high: existing.high, low: existing.low, close: existing.close, volume: existing.volume }
        : null;
      this.current.set(symbol, { minuteKey, open: price, high: price, low: price, close: price, volume });
      return completed;
    }

    existing.high = Decimal.max(existing.high, price);
    existing.low = Decimal.min(existing.low, price);
    existing.close = price;
    existing.volume = existing.volume.plus(volume);
    return null;
  }
}
