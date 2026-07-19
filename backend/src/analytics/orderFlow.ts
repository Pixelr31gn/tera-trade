/**
 * Directional read from live order-flow (see browserWatch/orderFlowListener.ts
 * and engine/liveOrderFlowCache.ts) -- combines trade-aggressor buy/sell
 * volume from the most recent flush window with resting best-bid/best-ask
 * size, into the same normalized [-1, 1] "does this support my side" scale
 * used by analytics/ppm.ts and analytics/fibonacci.ts.
 *
 * TopstepX's own crowd long/short "Tilt" bias is captured in OrderFlowSnapshot
 * but deliberately left out of this signal: whether retail crowd positioning
 * should be followed or faded isn't established for this account, and getting
 * the sign wrong would actively mislead scoring rather than just add noise.
 * It's still stored on SetupFeatures for future analysis once that's decided.
 */
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";

// Below this many trades in a flush window, buy/sell volume is too thin to
// mean anything (a single print can flip the imbalance to +/-1) -- treat as
// no signal rather than let noise drive the score.
const MIN_TRADES_FOR_VOLUME_SIGNAL = 3;

// Executed trade-aggressor flow can't be pulled or spoofed the way resting
// book size can, so it's weighted more heavily in the combined read.
const VOLUME_WEIGHT = 0.7;
const BOOK_WEIGHT = 0.3;

export function orderFlowDirectionSignal(snapshot: OrderFlowSnapshot | null, side: "long" | "short"): number {
  if (!snapshot) return 0;

  const totalVolume = snapshot.buyVolume + snapshot.sellVolume;
  const volumeImbalance =
    snapshot.tradeCount >= MIN_TRADES_FOR_VOLUME_SIGNAL && totalVolume > 0
      ? (snapshot.buyVolume - snapshot.sellVolume) / totalVolume
      : 0;

  const bidSize = snapshot.bestBidSize ?? 0;
  const askSize = snapshot.bestAskSize ?? 0;
  const totalBookSize = bidSize + askSize;
  const bookImbalance = totalBookSize > 0 ? (bidSize - askSize) / totalBookSize : 0;

  const combined = volumeImbalance * VOLUME_WEIGHT + bookImbalance * BOOK_WEIGHT;
  const signed = side === "long" ? combined : -combined;
  return Math.max(-1, Math.min(1, signed));
}
