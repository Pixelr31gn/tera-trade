import { describe, expect, it } from "vitest";
import { checkTimeframeAlignment } from "../src/risk/timeframeAlignmentGate.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const START = Date.UTC(2026, 10, 2, 0, 0, 0);

function barsFrom(priceAt: (i: number) => number, count = 1800): OhlcBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = priceAt(i);
    return { time: new Date(START + i * 60_000), open: close, high: close, low: close, close, volume: 1 };
  });
}

describe("checkTimeframeAlignment", () => {
  it("allows a long and blocks a short when price is above the EMA on every timeframe", () => {
    const bars = barsFrom((i) => 5000 + i);
    expect(checkTimeframeAlignment(bars, "long").allowed).toBe(true);
    expect(checkTimeframeAlignment(bars, "short").allowed).toBe(false);
  });

  it("allows a short and blocks a long when price is below the EMA on every timeframe", () => {
    const bars = barsFrom((i) => 9000 - i);
    expect(checkTimeframeAlignment(bars, "short").allowed).toBe(true);
    expect(checkTimeframeAlignment(bars, "long").allowed).toBe(false);
  });

  it("allows either side when at least one timeframe agrees (min 1 since 2026-11-11)", () => {
    // Long climb, then a pullback deep enough to sit under the 5m EMA but
    // still far above the slow-moving 1h EMA.
    const bars = barsFrom((i) => (i < 1700 ? 5000 + i : 6700 - (i - 1700)));
    const long = checkTimeframeAlignment(bars, "long");
    expect(long.allowed).toBe(true);
    expect(long.reason).toContain("5m below");
    expect(long.reason).toContain("60m above");
    expect(checkTimeframeAlignment(bars, "short").allowed).toBe(true);
  });

  it("fails closed without enough history for the slowest timeframe", () => {
    const check = checkTimeframeAlignment(barsFrom((i) => 5000 + i, 300), "long");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("60m bars");
  });
});
