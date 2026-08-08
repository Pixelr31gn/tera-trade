/**
 * Session-anchored VWAP -- cumulative (typical price x volume) / cumulative
 * volume, reset at the start of each UTC calendar day. Futures trade nearly
 * 24 hours with no single universal "session open," so a daily-UTC reset is
 * used as a well-understood, consistent approximation rather than trying to
 * model each exchange's actual settlement-to-settlement trading day.
 */
import type { OhlcBar } from "../regime/indicators.js";

export function computeSessionVwap(bars: OhlcBar[]): number | null {
  if (bars.length === 0) return null;

  const lastBar = bars[bars.length - 1]!;
  const dayKey = lastBar.time.toISOString().slice(0, 10);

  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const bar of bars) {
    if (bar.time.toISOString().slice(0, 10) !== dayKey) continue;
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
  }

  return cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null;
}

/**
 * Rolling VWAP -- same cumulative (typical price x volume) / cumulative
 * volume formula as the session version, but over a fixed trailing bar
 * count instead of resetting at a calendar boundary. Used by the Execution
 * Decision Engine's fair-value map as a faster-reacting fair-value
 * reference than the session anchor, which can be hours stale late in a
 * session.
 */
export function computeRollingVwap(bars: OhlcBar[], lookbackBars: number): number | null {
  if (bars.length < lookbackBars) return null;

  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const bar of bars.slice(-lookbackBars)) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
  }

  return cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null;
}
