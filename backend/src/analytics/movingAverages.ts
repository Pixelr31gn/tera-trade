/**
 * Simple moving averages over daily closes, used to classify multi-timeframe
 * trend direction via the classic 8/20/200 short/medium/long stack: price
 * and the three MAs fully stacked in ascending order reads as an uptrend,
 * fully descending reads as a downtrend, anything else is "mixed" (no clean
 * directional read) -- see engine/trendLevelsCache.ts.
 */
export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j]!;
    out[i] = sum / period;
  }
  return out;
}

export type MaDirection = "up" | "down" | "mixed";

export interface MaStack {
  maFast: number | null; // 8-period
  maMid: number | null; // 20-period
  maSlow: number | null; // 200-period
  direction: MaDirection;
}

export function classifyMaStack(closes: number[], fastPeriod = 8, midPeriod = 20, slowPeriod = 200): MaStack {
  const lastClose = closes.length > 0 ? closes[closes.length - 1]! : null;
  const maFastRaw = sma(closes, fastPeriod).at(-1) ?? NaN;
  const maMidRaw = sma(closes, midPeriod).at(-1) ?? NaN;
  const maSlowRaw = sma(closes, slowPeriod).at(-1) ?? NaN;

  const maFast = Number.isNaN(maFastRaw) ? null : maFastRaw;
  const maMid = Number.isNaN(maMidRaw) ? null : maMidRaw;
  const maSlow = Number.isNaN(maSlowRaw) ? null : maSlowRaw;

  let direction: MaDirection = "mixed";
  if (lastClose !== null && maFast !== null && maMid !== null && maSlow !== null) {
    if (lastClose > maFast && maFast > maMid && maMid > maSlow) direction = "up";
    else if (lastClose < maFast && maFast < maMid && maMid < maSlow) direction = "down";
  }

  return { maFast, maMid, maSlow, direction };
}
