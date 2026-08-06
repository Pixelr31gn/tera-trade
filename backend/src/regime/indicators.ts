/**
 * Technical indicators used for regime detection and scoring features.
 * Operates on plain ascending-time OHLCV bar arrays; each function returns an
 * array aligned to the input (NaN where there isn't enough warm-up data yet).
 */
export interface OhlcBar {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// A single degenerate bar (e.g. a bad data-feed tick briefly producing a
// wildly wrong OHLC bar) otherwise dominates every ATR-based calculation
// downstream for many minutes afterward -- Wilder's smoothing only decays by
// ~(1-1/period) per bar, so one huge true-range value stays influential long
// after the underlying bad tick is corrected. 2026-07-21 incident: a single
// zero-volume NQ bar with a false ~29,000-point range (and, via prevClose,
// the very next bar too) kept a live continuous-scan signal's ATR-derived
// stop distance in the thousands of points for several minutes after the
// bad tick itself had already self-healed. Clip each bar's raw true range to
// at most this multiple of the recent local median -- generous enough that
// a real volatility spike (a genuine gap, a news event) still reads as
// elevated, tight enough that one degenerate bar can't dominate the average.
const TRUE_RANGE_OUTLIER_CLIP_MULTIPLE = 10;
const TRUE_RANGE_OUTLIER_CLIP_WINDOW = 14;

function clipTrueRangeOutliers(raw: number[]): number[] {
  return raw.map((value, i) => {
    const reference = raw.slice(Math.max(0, i - TRUE_RANGE_OUTLIER_CLIP_WINDOW), i); // preceding bars only, excludes this one
    if (reference.length < Math.max(3, Math.floor(TRUE_RANGE_OUTLIER_CLIP_WINDOW / 2))) return value; // not enough history yet to judge
    const sorted = [...reference].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median <= 0) return value;
    return Math.min(value, median * TRUE_RANGE_OUTLIER_CLIP_MULTIPLE);
  });
}

export function trueRange(bars: OhlcBar[]): number[] {
  const raw = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1]!.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  });
  return clipTrueRangeOutliers(raw);
}

/** Wilder's smoothing (equivalent to pandas ewm(alpha=1/period, adjust=False)). */
function wilderSmooth(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const alpha = 1 / period;
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === undefined) {
      prev = mean(values.slice(0, i + 1));
    } else {
      prev = alpha * values[i]! + (1 - alpha) * prev;
    }
    out[i] = prev;
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function atr(bars: OhlcBar[], period = 14): number[] {
  return wilderSmooth(trueRange(bars), period);
}

export function adx(bars: OhlcBar[], period = 14): number[] {
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i]!.high - bars[i - 1]!.high;
    const downMove = bars[i - 1]!.low - bars[i]!.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const trSmooth = wilderSmooth(trueRange(bars), period);
  const plusDiSmooth = wilderSmooth(plusDm, period);
  const minusDiSmooth = wilderSmooth(minusDm, period);

  const dx: number[] = bars.map((_, i) => {
    const tr = trSmooth[i]!;
    const plusDi = (100 * plusDiSmooth[i]!) / tr;
    const minusDi = (100 * minusDiSmooth[i]!) / tr;
    const denom = plusDi + minusDi;
    return denom === 0 ? NaN : (100 * Math.abs(plusDi - minusDi)) / denom;
  });

  return wilderSmooth(
    dx.map((v) => (Number.isNaN(v) ? 0 : v)),
    period
  );
}

export function bollingerBandwidth(bars: OhlcBar[], period = 20, numStd = 2): number[] {
  const closes = bars.map((b) => b.close);
  return closes.map((_, i) => {
    if (i < period - 1) return NaN;
    const window = closes.slice(i - period + 1, i + 1);
    const sma = mean(window);
    const std = Math.sqrt(mean(window.map((v) => (v - sma) ** 2)));
    if (sma === 0) return NaN;
    return (2 * numStd * std) / sma;
  });
}

export function choppinessIndex(bars: OhlcBar[], period = 14): number[] {
  const tr = trueRange(bars);
  return bars.map((_, i) => {
    if (i < period - 1) return NaN;
    const trWindow = tr.slice(i - period + 1, i + 1);
    const highWindow = bars.slice(i - period + 1, i + 1).map((b) => b.high);
    const lowWindow = bars.slice(i - period + 1, i + 1).map((b) => b.low);
    const trSum = trWindow.reduce((a, b) => a + b, 0);
    const span = Math.max(...highWindow) - Math.min(...lowWindow);
    if (span <= 0) return NaN;
    return (100 * Math.log10(trSum / span)) / Math.log10(period);
  });
}

/** Rolling linear-regression slope (price units/bar) and R^2 of `close`. */
export function trendSlopeR2(bars: OhlcBar[], period = 20): { slope: number[]; r2: number[] } {
  const closes = bars.map((b) => b.close);
  const slope = new Array<number>(bars.length).fill(NaN);
  const r2 = new Array<number>(bars.length).fill(NaN);

  const x = Array.from({ length: period }, (_, i) => i);
  const xMean = mean(x);
  const xVar = x.reduce((acc, v) => acc + (v - xMean) ** 2, 0);

  for (let i = period - 1; i < closes.length; i++) {
    const y = closes.slice(i - period + 1, i + 1);
    const yMean = mean(y);
    const cov = x.reduce((acc, xv, idx) => acc + (xv - xMean) * (y[idx]! - yMean), 0);
    const s = xVar ? cov / xVar : 0;
    const pred = x.map((xv) => s * (xv - xMean) + yMean);
    const ssRes = y.reduce((acc, yv, idx) => acc + (yv - pred[idx]!) ** 2, 0);
    const ssTot = y.reduce((acc, yv) => acc + (yv - yMean) ** 2, 0);
    slope[i] = s;
    r2[i] = ssTot ? 1 - ssRes / ssTot : 0;
  }
  return { slope, r2 };
}

/** Percentile rank (0-1) of the latest ATR value within a rolling lookback window. */
export function atrPercentile(bars: OhlcBar[], atrPeriod = 14, lookback = 100): number[] {
  const atrValues = atr(bars, atrPeriod);
  return atrValues.map((_, i) => {
    const minPeriods = Math.max(10, Math.floor(lookback / 4));
    const start = Math.max(0, i - lookback + 1);
    const window = atrValues.slice(start, i + 1).filter((v) => !Number.isNaN(v));
    if (window.length < minPeriods || Number.isNaN(atrValues[i]!)) return NaN;
    const current = atrValues[i]!;
    const rank = window.filter((v) => v <= current).length;
    return rank / window.length;
  });
}

export function realizedVolZscore(bars: OhlcBar[], lookback = 100): number[] {
  const closes = bars.map((b) => b.close);
  const returns = closes.map((c, i) => (i === 0 ? NaN : (c - closes[i - 1]!) / closes[i - 1]!));
  return returns.map((_, i) => {
    if (i < lookback) return NaN;
    const window = returns.slice(i - lookback + 1, i + 1).filter((v) => !Number.isNaN(v));
    const m = mean(window);
    const std = Math.sqrt(mean(window.map((v) => (v - m) ** 2)));
    if (!std) return NaN;
    return (returns[i]! - m) / std;
  });
}

export function lastValid(values: number[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (!Number.isNaN(values[i]!)) return values[i]!;
  }
  return null;
}
