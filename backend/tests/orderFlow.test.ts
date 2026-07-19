import { describe, expect, it } from "vitest";
import { orderFlowDirectionSignal } from "../src/analytics/orderFlow.js";
import type { OrderFlowSnapshot } from "../src/browserWatch/orderFlowListener.js";

function snapshot(overrides: Partial<OrderFlowSnapshot> = {}): OrderFlowSnapshot {
  return {
    symbol: "ES",
    bestBidPrice: null,
    bestBidSize: null,
    bestAskPrice: null,
    bestAskSize: null,
    buyVolume: 0,
    sellVolume: 0,
    tradeCount: 0,
    tiltLongBias: null,
    tiltShortBias: null,
    ...overrides,
  };
}

describe("orderFlowDirectionSignal", () => {
  it("returns 0 when there is no snapshot yet", () => {
    expect(orderFlowDirectionSignal(null, "long")).toBe(0);
  });

  it("reads bullish for heavy buy-side aggressor volume", () => {
    const s = snapshot({ buyVolume: 90, sellVolume: 10, tradeCount: 10 });
    expect(orderFlowDirectionSignal(s, "long")).toBeGreaterThan(0);
    expect(orderFlowDirectionSignal(s, "short")).toBeLessThan(0);
  });

  it("reads bearish for heavy sell-side aggressor volume", () => {
    const s = snapshot({ buyVolume: 10, sellVolume: 90, tradeCount: 10 });
    expect(orderFlowDirectionSignal(s, "long")).toBeLessThan(0);
    expect(orderFlowDirectionSignal(s, "short")).toBeGreaterThan(0);
  });

  it("ignores volume imbalance below the minimum trade-count threshold", () => {
    const s = snapshot({ buyVolume: 10, sellVolume: 0, tradeCount: 1, bestBidSize: null, bestAskSize: null });
    expect(orderFlowDirectionSignal(s, "long")).toBe(0);
  });

  it("still reads book imbalance even with too few trades for the volume signal", () => {
    const s = snapshot({ buyVolume: 1, sellVolume: 0, tradeCount: 1, bestBidSize: 100, bestAskSize: 10 });
    expect(orderFlowDirectionSignal(s, "long")).toBeGreaterThan(0);
  });

  it("stays within [-1, 1] for extreme one-sided flow", () => {
    const s = snapshot({ buyVolume: 1000, sellVolume: 0, tradeCount: 50, bestBidSize: 500, bestAskSize: 0 });
    const signal = orderFlowDirectionSignal(s, "long");
    expect(signal).toBeLessThanOrEqual(1);
    expect(signal).toBeGreaterThanOrEqual(-1);
  });

  it("returns 0 for perfectly balanced flow and book", () => {
    const s = snapshot({ buyVolume: 50, sellVolume: 50, tradeCount: 10, bestBidSize: 20, bestAskSize: 20 });
    expect(orderFlowDirectionSignal(s, "long")).toBe(0);
  });
});
