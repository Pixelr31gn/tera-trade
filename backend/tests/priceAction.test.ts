import { describe, expect, it } from "vitest";
import { classifyLiquidity, classifyMarketStructure, describePriceAction } from "../src/analytics/priceAction.js";
import type { RegimeResult } from "../src/regime/classifier.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function regime(trendLabel: "up" | "down" | "none", adx: number | null): RegimeResult {
  return { trendLabel, volLabel: "normal", confidence: 0.5, features: { adx } };
}

function bar(open: number, high: number, low: number, close: number): OhlcBar {
  return { time: new Date(), open, high, low, close, volume: 100 };
}

describe("classifyMarketStructure", () => {
  it("labels a strong uptrend when ADX is high", () => {
    expect(classifyMarketStructure(regime("up", 40))).toBe("strong_uptrend");
  });

  it("labels a weak uptrend when ADX is modest", () => {
    expect(classifyMarketStructure(regime("up", 26))).toBe("weak_uptrend");
  });

  it("labels a strong downtrend when ADX is high", () => {
    expect(classifyMarketStructure(regime("down", 40))).toBe("strong_downtrend");
  });

  it("labels ranging regardless of ADX when trend is none", () => {
    expect(classifyMarketStructure(regime("none", 50))).toBe("ranging");
  });
});

describe("classifyLiquidity", () => {
  it("uses volume z-score when available", () => {
    expect(classifyLiquidity(1.5, "new_york")).toBe("high");
    expect(classifyLiquidity(-1.5, "new_york")).toBe("low");
    expect(classifyLiquidity(0, "new_york")).toBe("normal");
  });

  it("falls back to session-based liquidity when no volume data", () => {
    expect(classifyLiquidity(null, "asian")).toBe("low");
    expect(classifyLiquidity(null, "london")).toBe("normal");
    expect(classifyLiquidity(null, "new_york")).toBe("normal");
  });
});

describe("describePriceAction", () => {
  it("identifies a strong bullish body", () => {
    expect(describePriceAction([bar(100, 110, 99, 109)])).toBe("strong_bullish_body");
  });

  it("identifies a strong bearish body", () => {
    expect(describePriceAction([bar(109, 110, 99, 100)])).toBe("strong_bearish_body");
  });

  it("identifies an indecision doji", () => {
    expect(describePriceAction([bar(105, 110, 100, 105.5)])).toBe("indecision_doji");
  });

  it("identifies an upper-wick rejection", () => {
    // body=2 (range 10, ratio 0.2 -- clears the doji cutoff), upper wick=7, lower wick=1
    expect(describePriceAction([bar(103, 112, 102, 105)])).toBe("upper_wick_rejection");
  });

  it("identifies a lower-wick rejection", () => {
    // body=3 (range 11, ratio ~0.27 -- clears the doji cutoff), lower wick=7, upper wick=1
    expect(describePriceAction([bar(105, 106, 95, 102)])).toBe("lower_wick_rejection");
  });

  it("returns normal for an empty bar list", () => {
    expect(describePriceAction([])).toBe("normal");
  });
});
