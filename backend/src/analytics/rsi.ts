/**
 * Wilder's RSI(14) -- used purely as momentum *confirmation* in v3
 * (scoring/ruleScorerV3.ts), never as a standalone buy/sell signal.
 */
import type { OhlcBar } from "../regime/indicators.js";

export function computeRsi(bars: OhlcBar[], period = 14): number[] {
  const closes = bars.map((b) => b.close);
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

export function lastRsi(bars: OhlcBar[], period = 14): number | null {
  const series = computeRsi(bars, period);
  const last = series[series.length - 1];
  return last !== undefined && !Number.isNaN(last) ? last : null;
}
