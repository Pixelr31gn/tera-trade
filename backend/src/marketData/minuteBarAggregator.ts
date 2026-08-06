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
import { childLogger } from "../core/logger.js";

const logger = childLogger("minuteBarAggregator");

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

// A single real tick moving this much in ~5-10s would be a historic,
// circuit-breaker-tier event for ES/NQ -- far more likely a bad DOM scrape
// (grabbing an unrelated number off the page) than a real price. 2026-07-20
// incident: ES's extracted price read as 960.78 for several consecutive
// ticks across ~4 minutes (real ES was ~7492 at the time) and fed straight
// into bars_1m, inflating that bar's momentum-based scoring factors enough
// to nearly clear a resting-order entry. Rejected ticks don't move
// lastAcceptedPrice/lastAcceptedAt at all, so a genuinely-brief glitch just
// gets skipped without corrupting the bar.
const MAX_TICK_PCT_MOVE = 0.05;
// A real gap (or the reference price itself having gone stale/wrong) can't
// be told apart from a stuck bad reading in the moment -- but refusing
// forever would silently freeze this symbol's whole feed, which is worse
// than eventually accepting a late, real move. Self-heals after this long,
// but only once the new level is *confirmed* -- see
// OUTLIER_CONFIRMATIONS_REQUIRED below. 2026-07-21 incident: a single
// isolated bad tick (ES read as 2.30 against a real price of ~7549, with
// price_extraction_returned_null on every tick immediately before and after
// it) was accepted the instant the timeout elapsed, with zero corroboration,
// and fed a live continuous-scan entry an ATR-based stop/target computed off
// that garbage base price -- the resulting bracket order sat so far from the
// real market that TopstepX's own stop triggered immediately, closing the
// position within seconds of it opening.
const MAX_REJECTION_DURATION_MS = 2 * 60_000;
// Once the timeout above has elapsed, a single implausible tick still isn't
// trustworthy on its own -- a bad DOM scrape essentially never reproduces the
// same wrong number on consecutive reads, but a genuine gap or reopen keeps
// quoting near its new level every subsequent tick. Require this many
// consecutive post-timeout ticks within OUTLIER_CONFIRMATION_TOLERANCE of
// each other before trusting the new level enough to fold it into a bar.
const OUTLIER_CONFIRMATIONS_REQUIRED = 3;
const OUTLIER_CONFIRMATION_TOLERANCE = 0.01;

export class MinuteBarAggregator {
  private current = new Map<string, InProgressBar>();
  private lastAccepted = new Map<string, { price: Decimal; at: Date }>();
  private pendingOutlier = new Map<string, { price: Decimal; count: number }>();

  /**
   * Feeds one price tick for `symbol`. Returns the just-completed previous
   * minute's bar if this tick belongs to a new minute (so the caller can
   * persist it and trigger signal evaluation), or null if it's just
   * updating the still-forming current minute (or if this tick was
   * rejected as an implausible outlier -- see MAX_TICK_PCT_MOVE).
   */
  addTick(symbol: string, price: Decimal, volume: Decimal, at: Date): AggregatedMinuteBar | null {
    const last = this.lastAccepted.get(symbol);
    if (last && last.price.gt(0)) {
      const pctMove = price.minus(last.price).abs().dividedBy(last.price);
      const rejectionAgeMs = at.getTime() - last.at.getTime();
      if (pctMove.gt(MAX_TICK_PCT_MOVE)) {
        if (rejectionAgeMs < MAX_REJECTION_DURATION_MS) {
          logger.warn(
            { symbol, price: price.toString(), lastPrice: last.price.toString(), pctMove: pctMove.times(100).toFixed(2) },
            "tick_rejected_implausible_move"
          );
          return null;
        }

        const pending = this.pendingOutlier.get(symbol);
        const matchesPending =
          !!pending && price.minus(pending.price).abs().dividedBy(pending.price).lte(OUTLIER_CONFIRMATION_TOLERANCE);
        const confirmCount = matchesPending ? pending!.count + 1 : 1;

        if (confirmCount < OUTLIER_CONFIRMATIONS_REQUIRED) {
          this.pendingOutlier.set(symbol, { price, count: confirmCount });
          logger.warn(
            {
              symbol, price: price.toString(), lastPrice: last.price.toString(),
              pctMove: pctMove.times(100).toFixed(2), confirmCount, required: OUTLIER_CONFIRMATIONS_REQUIRED,
            },
            "tick_implausible_move_awaiting_confirmation"
          );
          return null;
        }

        this.pendingOutlier.delete(symbol);
        logger.error(
          { symbol, price: price.toString(), lastPrice: last.price.toString(), pctMove: pctMove.times(100).toFixed(2) },
          "tick_implausible_move_accepted_after_timeout"
        );
      } else {
        this.pendingOutlier.delete(symbol);
      }
    }
    this.lastAccepted.set(symbol, { price, at });

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
