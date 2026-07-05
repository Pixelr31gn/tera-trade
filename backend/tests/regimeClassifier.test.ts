import { describe, expect, it } from "vitest";
import { classifyRegime } from "../src/regime/classifier.js";
import type { OhlcBar } from "../src/regime/indicators.js";
import { makeRangingBars, makeTrendingBars } from "./fixtures.js";

describe("classifyRegime", () => {
  it("classifies a strong uptrend as trending up", () => {
    const result = classifyRegime(makeTrendingBars());
    expect(result.trendLabel).toBe("up");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("classifies a sideways market as ranging", () => {
    const result = classifyRegime(makeRangingBars());
    expect(result.trendLabel).toBe("none");
  });

  it("detects a downtrend", () => {
    const bars = makeTrendingBars();
    const downBars: OhlcBar[] = bars.map((b) => ({
      time: b.time,
      open: 200 - b.open,
      close: 200 - b.close,
      high: 200 - b.low,
      low: 200 - b.high,
      volume: b.volume,
    }));
    const result = classifyRegime(downBars);
    expect(result.trendLabel).toBe("down");
  });
});
