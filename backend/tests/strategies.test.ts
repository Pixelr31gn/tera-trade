import { describe, expect, it } from "vitest";
import { BreakoutStrategy } from "../src/strategy/breakout.js";
import { MeanReversionStrategy } from "../src/strategy/meanReversion.js";
import { TrendFollowingStrategy } from "../src/strategy/trendFollowing.js";
import { makeRangingBars, makeTrendingBars } from "./fixtures.js";

describe("BreakoutStrategy", () => {
  it("fires long on a new high somewhere in a strong uptrend", () => {
    const bars = makeTrendingBars();
    const strategy = new BreakoutStrategy();
    let found = null;
    for (let i = 21; i < bars.length; i++) {
      const signal = strategy.generateSignal("ES", bars.slice(0, i + 1));
      if (signal) {
        found = signal;
        break;
      }
    }
    expect(found).not.toBeNull();
    expect(found?.side).toBe("long");
  });
});

describe("MeanReversionStrategy", () => {
  it("fires on a Bollinger Band extreme in a ranging market", () => {
    const bars = makeRangingBars();
    const strategy = new MeanReversionStrategy();
    let found = null;
    for (let i = 30; i < bars.length; i++) {
      const signal = strategy.generateSignal("ES", bars.slice(0, i + 1));
      if (signal) {
        found = signal;
        break;
      }
    }
    expect(found).not.toBeNull();
    expect(["long", "short"]).toContain(found?.side);
  });
});

describe("TrendFollowingStrategy", () => {
  it("detects an EMA crossover in an uptrend", () => {
    const bars = makeTrendingBars();
    const strategy = new TrendFollowingStrategy();
    let fired = false;
    for (let i = 22; i < bars.length; i++) {
      const signal = strategy.generateSignal("ES", bars.slice(0, i + 1));
      if (signal) {
        expect(signal.side).toBe("long");
        fired = true;
        break;
      }
    }
    expect(fired).toBe(true);
  });
});
