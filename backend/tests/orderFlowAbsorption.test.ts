import { describe, expect, it } from "vitest";
import { computeDelta, detectAbsorption, detectDeltaDivergence } from "../src/analytics/orderFlowAbsorption.js";
import type { OrderFlowHistoryPoint } from "../src/engine/liveOrderFlowCache.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function flowPoint(overrides: Partial<OrderFlowHistoryPoint> = {}): OrderFlowHistoryPoint {
  return {
    symbol: "NQ",
    time: new Date("2026-01-01T00:00:00Z"),
    bestBidPrice: null,
    bestBidSize: null,
    bestAskPrice: null,
    bestAskSize: null,
    buyVolume: 10,
    sellVolume: 10,
    tradeCount: 5,
    tiltLongBias: null,
    tiltShortBias: null,
    ...overrides,
  };
}

function bar(close: number): OhlcBar {
  return { time: new Date("2026-01-01T00:00:00Z"), open: close, high: close + 1, low: close - 1, close, volume: 100 };
}

describe("computeDelta", () => {
  it("is positive when buy volume exceeds sell volume", () => {
    expect(computeDelta({ buyVolume: 60, sellVolume: 40 })).toBe(20);
  });
  it("is negative when sell volume exceeds buy volume", () => {
    expect(computeDelta({ buyVolume: 40, sellVolume: 60 })).toBe(-20);
  });
});

describe("detectAbsorption", () => {
  it("reports nothing with too little history", () => {
    const result = detectAbsorption([flowPoint()], bar(100), 5);
    expect(result.detected).toBe(false);
  });

  it("flags bid absorption when heavy sell volume doesn't push the close toward the low", () => {
    const history = [
      flowPoint({ sellVolume: 10 }),
      flowPoint({ sellVolume: 10 }),
      flowPoint({ sellVolume: 10 }),
      flowPoint({ sellVolume: 10 }),
      flowPoint({ sellVolume: 100 }), // heavy sell aggressor volume this window
    ];
    // Bar closed near its high, not its low -- despite heavy selling.
    const lastBar: OhlcBar = { time: new Date(), open: 100, high: 101, low: 99, close: 100.95, volume: 500 };
    const result = detectAbsorption(history, lastBar, 5);
    expect(result.detected).toBe(true);
    expect(result.side).toBe("bid");
  });

  it("flags ask absorption when heavy buy volume doesn't push the close toward the high", () => {
    const history = [
      flowPoint({ buyVolume: 10 }),
      flowPoint({ buyVolume: 10 }),
      flowPoint({ buyVolume: 10 }),
      flowPoint({ buyVolume: 10 }),
      flowPoint({ buyVolume: 100 }),
    ];
    const lastBar: OhlcBar = { time: new Date(), open: 100, high: 101, low: 99, close: 99.05, volume: 500 };
    const result = detectAbsorption(history, lastBar, 5);
    expect(result.detected).toBe(true);
    expect(result.side).toBe("ask");
  });

  it("does not flag absorption when volume is unremarkable", () => {
    const history = Array.from({ length: 5 }, () => flowPoint({ buyVolume: 10, sellVolume: 10 }));
    const lastBar: OhlcBar = { time: new Date(), open: 100, high: 101, low: 99, close: 100, volume: 100 };
    const result = detectAbsorption(history, lastBar, 5);
    expect(result.detected).toBe(false);
  });
});

describe("detectDeltaDivergence", () => {
  it("reports nothing with too little history", () => {
    const result = detectDeltaDivergence([flowPoint()], [bar(100)], 10);
    expect(result.divergent).toBe(false);
  });

  it("flags divergence when price rises but net delta is negative", () => {
    const history = Array.from({ length: 10 }, () => flowPoint({ buyVolume: 5, sellVolume: 15 })); // net negative delta
    const bars = Array.from({ length: 10 }, (_, i) => bar(100 + i)); // price rising
    const result = detectDeltaDivergence(history, bars, 10);
    expect(result.divergent).toBe(true);
    expect(result.cumulativeDelta).toBeLessThan(0);
  });

  it("does not flag divergence when price and delta agree", () => {
    const history = Array.from({ length: 10 }, () => flowPoint({ buyVolume: 15, sellVolume: 5 })); // net positive delta
    const bars = Array.from({ length: 10 }, (_, i) => bar(100 + i)); // price rising, agrees
    const result = detectDeltaDivergence(history, bars, 10);
    expect(result.divergent).toBe(false);
  });
});
