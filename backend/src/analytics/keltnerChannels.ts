/** Standard Keltner Channels: EMA(period) +/- atrMultiplier * ATR(period). */
import { atr } from "../regime/indicators.js";
import type { OhlcBar } from "../regime/indicators.js";
import { ema } from "./emaTrend.js";

export interface KeltnerChannels {
  middle: number;
  upper: number;
  lower: number;
}

export function computeKeltnerChannels(bars: OhlcBar[], period = 20, atrMultiplier = 2): KeltnerChannels | null {
  if (bars.length < period) return null;

  const closes = bars.map((b) => b.close);
  const middle = ema(closes, period).at(-1)!;

  const atrSeries = atr(bars, period).filter((v) => !Number.isNaN(v));
  if (atrSeries.length === 0) return null;
  const atrValue = atrSeries.at(-1)!;

  return { middle, upper: middle + atrMultiplier * atrValue, lower: middle - atrMultiplier * atrValue };
}
