/**
 * ES/NQ trend-pullback setup (operator spec, 2026-08-01; generalized to
 * shorts 2026-08-02): buy a shallow-to-moderate pullback into a rising
 * 15-minute trend once it retraces into the 40%-60% fib zone of the
 * preceding rally leg, entering on a 5-minute break of the pullback's own
 * last red bar -- or, symmetrically, sell a bounce into a FALLING 15-minute
 * trend once it retraces into the 40%-60% fib zone of the preceding decline
 * leg, entering on a 5-minute break of the bounce's own last green bar. The
 * original spec only covered longs; the short side is the same structural
 * idea mirrored (falling EMA + bounce-up correction = sell the rip, the same
 * way rising EMA + pullback-down correction = buy the dip), not a separate
 * strategy -- there's no principled reason a trend-continuation setup should
 * only work in one direction.
 *
 * Multi-timeframe by design (15m trend/fib context, 5m entry trigger), but
 * this system has only ever fed strategies a single 5-minute bar stream
 * (Strategy.generateSignal's whole contract) -- there's no separate 15m data
 * source anywhere. Rather than add one, this strategy derives 15m bars from
 * the same 5m bars it's given (aggregateTo15m below), keeping it a pure,
 * single-input strategy like every other one in this file's siblings.
 *
 * Stop/target: per operator decision (2026-08-01), this does NOT get a
 * custom stop/target mechanism -- structureSwingPrice carries the 5m 20 EMA
 * value, which risk/stops.ts's computeInitialStop already compares against
 * the ATR-based stop and uses whichever is tighter, exactly like every other
 * strategy's structure price. The take-profit is therefore the system's
 * standard 3.0x that stop distance, not the operator's original literal
 * "next 15m swing high" / "next liquidity pocket" targets -- an accepted
 * approximation, not an oversight.
 *
 * signalKind is "reversal" (a bounce off the fib-zone pullback, not a fresh
 * breakout of a level), so risk/engine.ts's S/R gate validates it against
 * the nearest real support/resistance level the normal reversal way.
 *
 * analyzeTrendPullback (2026-08-03) extracts the multi-step structural read
 * (EMA direction -> correction leg -> trend leg -> fib zone -> trigger) into
 * its own function, returning every intermediate piece instead of just a
 * final yes/no. generateSignal below still needs the all-or-nothing version
 * (a strategy either proposes a trade or it doesn't) -- but
 * scoring/ruleScorerV6.ts's new graduated point system needs the SAME
 * structural detection turned into partial credit instead of a hard
 * pass/fail, and needs it for candidates THIS strategy never even
 * proposed (v6 scores every strategy's signals, not just its own). Sharing
 * one analysis function keeps both consumers looking at identical structure
 * -- the alternative, a second bar-pattern-detection implementation in the
 * scorer, is exactly how the two would quietly drift apart over time.
 *
 * Two corrections (2026-08-03, operator-reported: a real, clean-looking
 * chart setup was scoring ~20% max in v6). Root-caused live against real
 * bars, not guessed:
 *
 * 1. The paragraph above ("this system has only ever fed strategies a
 *    single 5-minute bar stream") was true when written but had already gone
 *    stale -- confirmed against real bars.time deltas (296/299 consecutive
 *    gaps exactly 1 minute) that the live feed has actually been genuine
 *    1-minute bars since the MinuteBarAggregator fix (BUILD_HISTORY.md),
 *    which predates this file. Every place in this file that computed a "5m
 *    20 EMA" (the stop reference, and v6's EMA-proximity score) was really
 *    averaging the last 20 native bars -- a 20-*minute* lookback, not
 *    20x5min=100 minutes. Fixed by adding a genuine aggregateTo5m (mirrors
 *    aggregateTo15m) and running the EMA over that instead of the raw input.
 *    The raw/native array is kept for entryApprox and the trigger-bar check
 *    -- those want the freshest possible price, not a 5-minute-old close.
 *
 * 2. Separately: the same 8.4-hour real feed outage that motivated (1) also
 *    showed analyzeTrendPullback needing a full 6 hours of clean, gap-free
 *    15m buckets (EMA_PERIOD=20 + EMA_SLOPE_LOOKBACK_BARS=4) before it would
 *    even attempt a trend-direction read -- meaning several hours of
 *    complete blindness after any real outage, a recurring, documented
 *    reality for this system (BUILD_HISTORY.md's "Known limitations"). See
 *    EMA_MIN_WARMUP_BARS below for the fix and its trade-off (operator
 *    decision, not harness-validated).
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import { ema } from "../analytics/emaTrend.js";
import type { Signal, Strategy } from "./types.js";

const FIFTEEN_MIN_MS = 15 * 60_000;
const FIVE_MIN_MS = 5 * 60_000;

const EMA_PERIOD = 20; // genuine 20 EMA, per operator spec -- NOT reduced below. See EMA_MIN_WARMUP_BARS for the actual gap-recovery fix.
// 1 hour on 15m -- deliberately NOT reduced alongside EMA_MIN_WARMUP_BARS
// below (tried reducing to 2 bars/30min during the same 2026-08-03 pass;
// reverted). The slope check compares the EMA now vs. this many bars ago to
// read direction -- it has to look back FURTHER than a plausible correction
// leg, or it just measures the correction itself instead of the trend the
// correction is pulling back from. Caught concretely: with a 2-bar lookback,
// tests/strategies.test.ts's own 4-bar correction fixture (a real, clean
// uptrend-then-pullback shape) read as "down" -- both compared points sat
// inside the correction. MIN_CORRECTION_BARS=3 is only a minimum; 4 is a
// perfectly ordinary correction length, so 4 stays the floor here too.
const EMA_SLOPE_LOOKBACK_BARS = 4;
// How many real 15m bars must exist before an EMA(20) reading is trusted at
// all. A textbook EMA(20) "needs" period=20 bars to fully converge past its
// own seed value, but that's a convention, not a hard requirement -- alpha =
// 2/21 means the seed's residual weight decays fast regardless of when you
// start trusting it (~45% remaining at 8 bars, ~14% at the full 20).
// Operator decision (2026-08-03), after a real 8.4-hour feed outage left
// analyzeTrendPullback needing 6 more hours of clean data before it would
// read a trend direction at all -- a recurring problem given this system's
// documented history of multi-hour feed outages (BUILD_HISTORY.md). Trades
// some of that precision for recovering in ~3 hours instead of 6
// (EMA_MIN_WARMUP_BARS + EMA_SLOPE_LOOKBACK_BARS = 12 bars = 3hr, down from
// 24 bars = 6hr) -- EMA_SLOPE_LOOKBACK_BARS itself is held at its original,
// tested-safe value (see that constant's own comment) rather than also
// shrunk, so all of this reduction comes from the warmup side. Not
// harness-validated -- a real trade-off, not a free win; revisit with
// src/replay/ if live results suggest 8 bars reads direction unreliably.
const EMA_MIN_WARMUP_BARS = 8;
const MIN_CORRECTION_BARS = 3;
const CORRECTION_LEG_SEARCH_WINDOW = 5; // how many recent 15m bars back to look for where a correction leg most recently ended -- allows a bar or two of post-correction consolidation before the 5m trigger, per the operator spec's "consolidates on 5m" step
// Originally read as "how far back to search for the rally leg's own swing
// low" -- picking the single lowest low within a fixed 20-bar window as the
// rally's start point, regardless of what was actually happening across
// those bars. Operator correction (2026-08-02): a rally isn't defined by a
// specific bar count, it's a structural run of trend bars with little
// counter-move -- the same "little to no resistance/support" bar already
// enforced by MAX_TREND_LEG_COUNTERTREND_BARS below. A real, clean short
// rally (or decline, on the short side) could get its swing point dragged
// back into an unrelated, disconnected earlier move that happened to sit
// within the same 20-bar window, then get rejected for countertrend bars
// that were never actually part of this leg at all.
// findPrecedingTrendLeg now walks backward from the peak/trough bar-by-bar,
// extending the leg only while it still looks like a clean trend move
// (countertrend-bar count <= MAX_TREND_LEG_COUNTERTREND_BARS, never two
// countertrend bars in a row), and stops there -- naturally finding trend
// legs of any length. This constant is now only a hard safety cap on how far
// back that walk is ever allowed to go, not a target or minimum length.
// Shared by both directions since the same "how far is too far to search"
// question applies symmetrically.
const TREND_LEG_LOOKBACK_BARS = 20;
// "little to no resistance/support" during the trend leg -- interpreted as:
// at most one countertrend bar across the whole leg. Same bound both
// directions (a red bar inside a rally, or a green bar inside a decline).
const MAX_TREND_LEG_COUNTERTREND_BARS = 1;
const FIB_LOW = 0.4;
const FIB_HIGH = 0.6;

export type TrendDirection = "up" | "down";

export function isRed(bar: OhlcBar): boolean {
  return bar.close < bar.open;
}

export function isGreen(bar: OhlcBar): boolean {
  return bar.close > bar.open;
}

/** The correction always runs counter to the trend: red bars pulling back down out of an uptrend, green bars bouncing up out of a downtrend. */
function isCorrectionColor(bar: OhlcBar, direction: TrendDirection): boolean {
  return direction === "up" ? isRed(bar) : isGreen(bar);
}

// Minimum sub-bars for a bucket to count as a closed 15m candle. Written
// assuming a 5-minute input stream (3 x 5m = 15m, "all 3 present" = closed)
// -- but confirmed live (2026-08-03, diagnostic against real bars.time
// deltas: 296/299 consecutive-bar gaps were exactly 1 minute) that the input
// has actually been genuine 1-minute bars since the MinuteBarAggregator fix
// (see BUILD_HISTORY.md), predating this file. A stale "< 3" check was
// accepting a bucket with only 3 of a possible ~15 sub-bars -- as little as
// 3 real minutes out of 15 -- as a finished, trustworthy candle, silently
// letting a gappy window (a browser/CDP hiccup mid-bucket) masquerade as a
// clean one. Requiring 13 of 15 tolerates the occasional single dropped
// tick (matches this file's existing tolerance elsewhere, e.g.
// MAX_TREND_LEG_COUNTERTREND_BARS) without demanding literal perfection.
const MIN_SUBBARS_FOR_COMPLETE_15M_BUCKET = 13;
// Same reasoning as MIN_SUBBARS_FOR_COMPLETE_15M_BUCKET, scaled to a 5-minute
// bucket of 1-minute sub-bars (5 possible, tolerate 1 missing).
const MIN_SUBBARS_FOR_COMPLETE_5M_BUCKET = 4;

/**
 * Aggregates 1-minute bars into real, clock-aligned buckets of bucketMs
 * width. Drops any bucket that isn't essentially fully populated -- an
 * in-progress or gappy bucket isn't a real closed candle, and treating one
 * as one would either be a small look-ahead (still forming) or corrupt the
 * OHLC read off missing data (gappy).
 */
function aggregateToClockBuckets(bars1m: OhlcBar[], bucketMs: number, minSubBars: number): OhlcBar[] {
  const buckets = new Map<number, OhlcBar[]>();
  for (const bar of bars1m) {
    const bucketStart = Math.floor(bar.time.getTime() / bucketMs) * bucketMs;
    const group = buckets.get(bucketStart);
    if (group) group.push(bar);
    else buckets.set(bucketStart, [bar]);
  }
  const bucketStarts = [...buckets.keys()].sort((a, b) => a - b);
  const result: OhlcBar[] = [];
  for (const bucketStart of bucketStarts) {
    const group = buckets.get(bucketStart)!;
    if (group.length < minSubBars) continue; // incomplete/gappy bucket (session start/end, still-forming current one, or a feed outage)
    result.push({
      time: new Date(bucketStart),
      open: group[0]!.open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: group[group.length - 1]!.close,
      volume: group.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  return result;
}

/** Real, clock-aligned 15-minute bars (:00-:15, :15-:30, etc.), not just "every N bars from array start." */
export function aggregateTo15m(bars1m: OhlcBar[]): OhlcBar[] {
  return aggregateToClockBuckets(bars1m, FIFTEEN_MIN_MS, MIN_SUBBARS_FOR_COMPLETE_15M_BUCKET);
}

/**
 * Real, clock-aligned 5-minute bars -- added 2026-08-03 so the "5m 20 EMA"
 * (the stop reference, and v6's EMA-proximity score) is actually computed
 * over 5-minute candles instead of silently averaging the raw native
 * (1-minute) bar stream. See this file's header for the full story.
 */
export function aggregateTo5m(bars1m: OhlcBar[]): OhlcBar[] {
  return aggregateToClockBuckets(bars1m, FIVE_MIN_MS, MIN_SUBBARS_FOR_COMPLETE_5M_BUCKET);
}

export interface CorrectionLeg {
  startIndex: number;
  endIndex: number;
}

/**
 * Scans backward from the most recent 15m bars for a run of >= 3 consecutive
 * correction-colored bars (red for an uptrend pullback, green for a
 * downtrend bounce) forming strictly lower highs AND lower lows (uptrend
 * case) or strictly higher highs AND higher lows (downtrend case) -- the
 * operator spec's "correction leg." Tries the most recent possible end-point
 * first (the search window allows the leg to have finished a bar or two
 * before the very last one, covering the spec's separate 5m "consolidation"
 * step).
 */
function findCorrectionLeg(bars15m: OhlcBar[], direction: TrendDirection): CorrectionLeg | null {
  const n = bars15m.length;
  const earliestEnd = Math.max(MIN_CORRECTION_BARS - 1, n - 1 - CORRECTION_LEG_SEARCH_WINDOW);
  for (let end = n - 1; end >= earliestEnd; end--) {
    if (!isCorrectionColor(bars15m[end]!, direction)) continue;
    let start = end;
    while (
      start - 1 >= 0 &&
      isCorrectionColor(bars15m[start - 1]!, direction) &&
      (direction === "up"
        ? bars15m[start - 1]!.high > bars15m[start]!.high && bars15m[start - 1]!.low > bars15m[start]!.low
        : bars15m[start - 1]!.high < bars15m[start]!.high && bars15m[start - 1]!.low < bars15m[start]!.low)
    ) {
      start--;
    }
    if (end - start + 1 >= MIN_CORRECTION_BARS) return { startIndex: start, endIndex: end };
  }
  return null;
}

export interface TrendLeg {
  /** Further back in time -- the swing low (uptrend) or swing high (downtrend) that starts the leg. */
  farIndex: number;
  /** The bar right before the correction started -- the swing high (uptrend) or swing low (downtrend). */
  nearIndex: number;
  farPrice: number;
  nearPrice: number;
}

/**
 * The trend leg is whatever preceded the correction -- its near end (a peak
 * for an uptrend, a trough for a downtrend) is the bar right before the
 * correction started. Walks backward from there bar-by-bar, extending the
 * leg only while it still looks like a clean trend move (at most
 * MAX_TREND_LEG_COUNTERTREND_BARS total countertrend bars, never two in a
 * row -- that's a real reversal, not "little resistance/support"), stopping
 * at the first bar that would violate either condition or after
 * TREND_LEG_LOOKBACK_BARS bars as a safety cap. See that constant's comment
 * for why this replaced a fixed-window highest/lowest search.
 */
function findPrecedingTrendLeg(bars15m: OhlcBar[], correctionStartIndex: number, direction: TrendDirection): TrendLeg | null {
  const nearIndex = correctionStartIndex - 1;
  if (nearIndex < 0) return null;
  const earliestIndex = Math.max(0, nearIndex - TREND_LEG_LOOKBACK_BARS);

  let farIndex = nearIndex;
  let countertrendCount = 0;
  let consecutiveCountertrend = 0;
  for (let i = nearIndex; i >= earliestIndex; i--) {
    // The trend leg's own countertrend color is the SAME color as the
    // correction (a red bar inside a rally, a green bar inside a decline) --
    // isCorrectionColor is reused rather than redeclaring the same check.
    const countertrend = isCorrectionColor(bars15m[i]!, direction);
    const nextCount = countertrend ? countertrendCount + 1 : countertrendCount;
    const nextConsecutive = countertrend ? consecutiveCountertrend + 1 : 0;
    if (nextCount > MAX_TREND_LEG_COUNTERTREND_BARS || nextConsecutive >= 2) break;
    countertrendCount = nextCount;
    consecutiveCountertrend = nextConsecutive;
    const better = direction === "up" ? bars15m[i]!.low < bars15m[farIndex]!.low : bars15m[i]!.high > bars15m[farIndex]!.high;
    if (better) farIndex = i;
  }

  if (farIndex >= nearIndex) return null; // no real range to measure a trend leg over
  return {
    farIndex, nearIndex,
    farPrice: direction === "up" ? bars15m[farIndex]!.low : bars15m[farIndex]!.high,
    nearPrice: direction === "up" ? bars15m[nearIndex]!.high : bars15m[nearIndex]!.low,
  };
}

export interface TrendPullbackAnalysis {
  bars15m: OhlcBar[];
  /** Genuine, clock-aligned 5-minute bars (see aggregateTo5m) -- the real "5m" reference for EMA reads, distinct from the raw native (1-minute) input. */
  bars5m: OhlcBar[];
  /** null if the 15m 20 EMA is exactly flat or there aren't enough 15m bars yet. */
  direction: TrendDirection | null;
  correctionLeg: CorrectionLeg | null;
  trendLeg: TrendLeg | null;
  /** Always positive -- the trend leg's total size. Null until both legs are found. */
  fibRange: number | null;
  /** The most recent 15m bar's close -- what the fib zone is measured against. */
  referencePrice: number | null;
  /** 0 = right at the trend leg's peak/trough (no pullback yet), 100 = fully retraced back to the far end. Can exceed 100 if price round-tripped past the trend leg's own start. */
  retracementPct: number | null;
  /** The correction leg's last bar's high (uptrend) or low (downtrend) -- the level a real breakout has to clear. */
  triggerLevel: number | null;
  /** Whether the most recent 5m bar has actually broken the trigger level (high/low, not close). */
  triggered: boolean;
}

/**
 * The full structural read, every intermediate step exposed -- see this
 * file's header for why generateSignal and ruleScorerV6.ts both build on
 * this instead of each detecting the pattern their own way.
 */
export function analyzeTrendPullback(bars1m: OhlcBar[]): TrendPullbackAnalysis {
  const bars5m = aggregateTo5m(bars1m);
  const empty: TrendPullbackAnalysis = {
    bars15m: [], bars5m, direction: null, correctionLeg: null, trendLeg: null,
    fibRange: null, referencePrice: null, retracementPct: null, triggerLevel: null, triggered: false,
  };

  const bars15m = aggregateTo15m(bars1m);
  if (bars15m.length < EMA_MIN_WARMUP_BARS + EMA_SLOPE_LOOKBACK_BARS) return { ...empty, bars15m };

  const ema15m = ema(bars15m.map((b) => b.close), EMA_PERIOD);
  const emaNow = ema15m.at(-1)!;
  const emaBefore = ema15m.at(-1 - EMA_SLOPE_LOOKBACK_BARS)!;
  if (emaNow === emaBefore) return { ...empty, bars15m };
  const direction: TrendDirection = emaNow > emaBefore ? "up" : "down";

  const correctionLeg = findCorrectionLeg(bars15m, direction);
  if (!correctionLeg) return { ...empty, bars15m, direction };

  const trendLeg = findPrecedingTrendLeg(bars15m, correctionLeg.startIndex, direction);
  if (!trendLeg) return { ...empty, bars15m, direction, correctionLeg };

  const fibRange = direction === "up" ? trendLeg.nearPrice - trendLeg.farPrice : trendLeg.farPrice - trendLeg.nearPrice;
  if (fibRange <= 0) return { ...empty, bars15m, direction, correctionLeg, trendLeg };

  const referencePrice = bars15m.at(-1)!.close;
  const retracementPct = (Math.abs(trendLeg.nearPrice - referencePrice) / fibRange) * 100;

  const correctionEndBar = bars15m[correctionLeg.endIndex]!;
  const triggerLevel = direction === "up" ? correctionEndBar.high : correctionEndBar.low;
  // The trigger check stays on the raw/native last bar, not the 5m
  // aggregate -- "did we just break the level" should use the freshest
  // possible price, not a close that could be up to ~5 minutes stale.
  const lastBar1m = bars1m.at(-1)!;
  const triggered = direction === "up" ? lastBar1m.high > triggerLevel : lastBar1m.low < triggerLevel;

  return { bars15m, bars5m, direction, correctionLeg, trendLeg, fibRange, referencePrice, retracementPct, triggerLevel, triggered };
}

export interface ExplicitStopTarget {
  stopPrice: number;
  takeProfitPrice: number;
}

/**
 * Stop/target (operator spec, 2026-08-03): the stop always rests at the 5m
 * 20 EMA -- not blended against ATR the way every other strategy's
 * structureSwingPrice competes and takes whichever is tighter (see
 * risk/stops.ts's computeInitialStop) -- and the target is the trend leg's
 * own peak/trough, the level price retraced FROM, clamped to a 2:1-4:1
 * reward:risk band off that stop distance ("prioritize 2:1... ideally range
 * from 2:1 to 4:1 depending on price action" -- "price action" being how
 * far the real structural target actually sits: use it as-is inside the
 * band, pull it in if further than 4x, extend to 2x if closer).
 * entryApprox mirrors decisionCore.ts's own convention of using the signal
 * bar's close as entryPrice for every risk computation -- the real fill
 * happens one bar later, but that approximation is already how every other
 * strategy's stop/target gets computed here, not a new one introduced for
 * this override.
 *
 * Returns null when the 5m EMA doesn't actually sit on the valid side of
 * price (below entry for a long, above for a short) -- a real possibility
 * on a fast, large trend leg the 5m EMA (noisier and faster than the 15m
 * structure the rest of the pattern is built on) hasn't caught up to yet.
 * Callers fall back to no override at all rather than hand risk/tradePlan.ts
 * a backwards stop -- computeInitialStop's normal structure-vs-ATR blend
 * takes over exactly as it does for every other strategy.
 */
export function computeExplicitStopTarget(bars1m: OhlcBar[], trendLeg: TrendLeg, direction: TrendDirection): ExplicitStopTarget | null {
  const bars5m = aggregateTo5m(bars1m);
  const closes5m = bars5m.map((b) => b.close);
  if (closes5m.length < EMA_PERIOD) return null;
  const ema5mValue = ema(closes5m, EMA_PERIOD).at(-1)!;
  // entryApprox stays on the raw/native bar -- the freshest price available,
  // not a 5-minute-old aggregated close.
  const entryApprox = bars1m.at(-1)!.close;
  const stopDistance = Math.abs(entryApprox - ema5mValue);
  const emaIsValidStop = stopDistance > 0 && (direction === "up" ? ema5mValue < entryApprox : ema5mValue > entryApprox);
  if (!emaIsValidStop) return null;

  const naturalTargetDistance = Math.abs(trendLeg.nearPrice - entryApprox);
  const clampedTargetDistance = Math.min(Math.max(naturalTargetDistance, stopDistance * 2), stopDistance * 4);
  return {
    stopPrice: ema5mValue,
    takeProfitPrice: direction === "up" ? entryApprox + clampedTargetDistance : entryApprox - clampedTargetDistance,
  };
}

export class TrendPullbackFibStrategy implements Strategy {
  strategyId = "trend_pullback_fib_buy";

  generateSignal(symbol: string, bars1m: OhlcBar[]): Signal | null {
    const a = analyzeTrendPullback(bars1m);
    if (!a.direction || !a.correctionLeg || !a.trendLeg || a.fibRange === null || a.referencePrice === null || a.retracementPct === null) return null;

    const inFibZone = a.direction === "up"
      ? a.referencePrice <= a.trendLeg.nearPrice - a.fibRange * FIB_LOW && a.referencePrice >= a.trendLeg.nearPrice - a.fibRange * FIB_HIGH
      : a.referencePrice >= a.trendLeg.nearPrice + a.fibRange * FIB_LOW && a.referencePrice <= a.trendLeg.nearPrice + a.fibRange * FIB_HIGH;
    if (!inFibZone || !a.triggered) return null;

    // Stop reference: the genuine 5m 20 EMA (see file header -- fed in as
    // structureSwingPrice, competes against the ATR-based stop the normal
    // way). Reuses a.bars5m rather than re-aggregating.
    const closes5m = a.bars5m.map((b) => b.close);
    if (closes5m.length < EMA_PERIOD) return null;
    const ema5mValue = ema(closes5m, EMA_PERIOD).at(-1)!;

    const explicit = computeExplicitStopTarget(bars1m, a.trendLeg, a.direction);
    const explicitStopPrice = explicit ? new Decimal(explicit.stopPrice) : undefined;
    const explicitTakeProfitPrice = explicit ? new Decimal(explicit.takeProfitPrice) : undefined;

    return {
      strategyId: this.strategyId,
      symbol,
      side: a.direction === "up" ? "long" : "short",
      signalKind: "reversal",
      structureSwingPrice: new Decimal(ema5mValue),
      explicitStopPrice,
      explicitTakeProfitPrice,
      reason:
        a.direction === "up"
          ? `5m broke above the correction leg's last red bar (${a.triggerLevel!.toFixed(2)}) ` +
            `after retracing to ${a.retracementPct.toFixed(0)}% ` +
            `of the rally from ${a.trendLeg.farPrice.toFixed(2)} to ${a.trendLeg.nearPrice.toFixed(2)}, ` +
            `with the 15m 20 EMA rising` +
            (explicitTakeProfitPrice ? `; stop at the 5m 20 EMA (${ema5mValue.toFixed(2)}), target ${explicitTakeProfitPrice.toFixed(2)}` : "")
          : `5m broke below the correction leg's last green bar (${a.triggerLevel!.toFixed(2)}) ` +
            `after retracing to ${a.retracementPct.toFixed(0)}% ` +
            `of the decline from ${a.trendLeg.farPrice.toFixed(2)} to ${a.trendLeg.nearPrice.toFixed(2)}, ` +
            `with the 15m 20 EMA falling` +
            (explicitTakeProfitPrice ? `; stop at the 5m 20 EMA (${ema5mValue.toFixed(2)}), target ${explicitTakeProfitPrice.toFixed(2)}` : ""),
    };
  }
}
