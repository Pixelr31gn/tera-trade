/** Standard Bollinger Bands: SMA(period) +/- stdDevMultiplier * stddev(period). */
import type { OhlcBar } from "../regime/indicators.js";

export interface BollingerBands {
  middle: number;
  upper: number;
  lower: number;
  /** (upper - lower) / middle -- a normalized volatility read, comparable across instruments/price levels. */
  bandwidth: number;
}

export function computeBollingerBands(bars: OhlcBar[], period = 20, stdDevMultiplier = 2): BollingerBands | null {
  if (bars.length < period) return null;

  const closes = bars.slice(-period).map((b) => b.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + (c - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mean + stdDevMultiplier * stdDev;
  const lower = mean - stdDevMultiplier * stdDev;
  return { middle: mean, upper, lower, bandwidth: mean !== 0 ? (upper - lower) / mean : 0 };
}
