/**
 * Order-flow absorption and delta divergence -- approximated from
 * aggregate per-flush-window buy/sell aggressor volume (see
 * browserWatch/orderFlowListener.ts), not true tick-by-tick footprint data.
 * Real absorption/divergence detection normally reads individual prints
 * against live bid/ask depth changes; without that, these are deliberately
 * coarse, clearly-labeled approximations for the Execution Decision
 * Engine's fair-value map, not validated signals -- treat as a minor input
 * until real outcome data says otherwise (same "hand-set prior, revisit
 * with data" posture as the rest of this scorer).
 */
import type { OrderFlowHistoryPoint } from "../engine/liveOrderFlowCache.js";
import type { OhlcBar } from "../regime/indicators.js";

export interface AbsorptionReading {
  detected: boolean;
  side: "bid" | "ask" | null;
  description: string;
}

// Hand-set: "heavy" aggressor volume is 1.5x the recent per-window average;
// "price barely moved" is under 10% of the bar's own range. Neither has
// been fitted against real outcomes yet.
const HEAVY_VOLUME_MULTIPLIER = 1.5;
const STALL_RANGE_FRACTION = 0.1;

export function detectAbsorption(history: OrderFlowHistoryPoint[], lastBar: OhlcBar, lookback = 5): AbsorptionReading {
  if (history.length < lookback) {
    return { detected: false, side: null, description: "not enough order-flow history" };
  }
  const recent = history.slice(-lookback);
  const latest = recent.at(-1)!;
  const avgSellVolume = recent.reduce((sum, h) => sum + h.sellVolume, 0) / recent.length;
  const avgBuyVolume = recent.reduce((sum, h) => sum + h.buyVolume, 0) / recent.length;

  const barRange = lastBar.high - lastBar.low;
  const closeNearHigh = barRange > 0 && lastBar.high - lastBar.close < barRange * STALL_RANGE_FRACTION;
  const closeNearLow = barRange > 0 && lastBar.close - lastBar.low < barRange * STALL_RANGE_FRACTION;

  // Bid absorption: heavy sell-aggressor volume, but price didn't actually
  // give way (closed away from the low) -- a resting bid likely absorbed it.
  if (latest.sellVolume > avgSellVolume * HEAVY_VOLUME_MULTIPLIER && !closeNearLow) {
    return { detected: true, side: "bid", description: `sell volume ${latest.sellVolume.toFixed(0)} vs avg ${avgSellVolume.toFixed(0)}, price held -- possible bid absorption` };
  }
  // Ask absorption: mirror case for buy-aggressor volume against a held price.
  if (latest.buyVolume > avgBuyVolume * HEAVY_VOLUME_MULTIPLIER && !closeNearHigh) {
    return { detected: true, side: "ask", description: `buy volume ${latest.buyVolume.toFixed(0)} vs avg ${avgBuyVolume.toFixed(0)}, price held -- possible ask absorption` };
  }
  return { detected: false, side: null, description: "no absorption pattern" };
}

export interface DeltaDivergence {
  divergent: boolean;
  cumulativeDelta: number;
  description: string;
}

/** Net aggressor volume (buy - sell) for a single snapshot -- positive means buyers were more aggressive in that window. */
export function computeDelta(snapshot: { buyVolume: number; sellVolume: number }): number {
  return snapshot.buyVolume - snapshot.sellVolume;
}

export function detectDeltaDivergence(history: OrderFlowHistoryPoint[], bars: OhlcBar[], lookback = 10): DeltaDivergence {
  if (history.length < lookback || bars.length < lookback) {
    return { divergent: false, cumulativeDelta: 0, description: "not enough history" };
  }
  const recentFlow = history.slice(-lookback);
  const recentBars = bars.slice(-lookback);
  const cumulativeDelta = recentFlow.reduce((sum, h) => sum + computeDelta(h), 0);
  const priceChange = recentBars.at(-1)!.close - recentBars[0]!.close;

  const divergent = (priceChange > 0 && cumulativeDelta < 0) || (priceChange < 0 && cumulativeDelta > 0);
  return {
    divergent,
    cumulativeDelta,
    description: divergent
      ? `price ${priceChange > 0 ? "rose" : "fell"} while net order-flow delta was ${cumulativeDelta > 0 ? "positive" : "negative"} -- aggressor flow disagrees with the move`
      : "no divergence",
  };
}
