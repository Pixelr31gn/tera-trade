import { describe, expect, it } from "vitest";
import { summarizeTape, type OrderFlowSnapshot } from "../src/browserWatch/orderFlowListener.js";
import { computePaperWeight, PW_FADE_MAX_POINTS, PW_IMBALANCE_MAX_POINTS } from "../src/scoring/paperWeight.js";

const AT = new Date("2026-10-13T22:30:00Z");

function tape(buy: number, sell: number, buyPrior = 0, sellPrior = 0, ageMs = 5_000): OrderFlowSnapshot {
  return {
    symbol: "NQ",
    bestBidPrice: null, bestBidSize: null, bestAskPrice: null, bestAskSize: null,
    buyVolume: 0, sellVolume: 0, tradeCount: 0,
    tiltLongBias: null, tiltShortBias: null,
    tapeBuyRecent: buy, tapeSellRecent: sell, tapeBuyPrior: buyPrior, tapeSellPrior: sellPrior,
    tapeAtMs: AT.getTime() - ageMs,
  };
}

describe("summarizeTape", () => {
  it("splits flush slices into the last minute and the minute before", () => {
    const now = AT.getTime();
    const s = summarizeTape([
      { atMs: now - 100_000, buy: 5, sell: 40 }, // prior minute
      { atMs: now - 70_000, buy: 3, sell: 20 },  // prior minute
      { atMs: now - 30_000, buy: 25, sell: 4 },  // recent
      { atMs: now, buy: 10, sell: 1 },           // recent
      { atMs: now - 130_000, buy: 99, sell: 99 }, // too old, ignored
    ], now);
    expect(s).toEqual({ buyRecent: 35, sellRecent: 5, buyPrior: 8, sellPrior: 60 });
  });
});

describe("computePaperWeight", () => {
  it("boosts a long when buys outnumber sells, in proportion", () => {
    expect(computePaperWeight(tape(30, 10), "long", AT).adjustmentPoints).toBeCloseTo(0.5 * PW_IMBALANCE_MAX_POINTS, 1);
  });

  it("is boost-only: a short gets nothing when buys lead", () => {
    expect(computePaperWeight(tape(30, 10), "short", AT).adjustmentPoints).toBe(0);
  });

  it("adds more for a long when sells disappear vs the prior minute", () => {
    // Sells fell from 60 to 6 (90% drop), buys lead 34/6.
    const pw = computePaperWeight(tape(34, 6, 10, 60), "long", AT);
    const imbalancePart = ((34 - 6) / 40) * PW_IMBALANCE_MAX_POINTS;
    expect(pw.adjustmentPoints).toBeCloseTo(imbalancePart + 0.9 * PW_FADE_MAX_POINTS, 1);
    expect(pw.description).toContain("sells dried up 90%");
  });

  it("mirrors for shorts: sells leading plus buys drying up", () => {
    const pw = computePaperWeight(tape(5, 35, 50, 20), "short", AT);
    expect(pw.adjustmentPoints).toBeGreaterThan(((35 - 5) / 40) * PW_IMBALANCE_MAX_POINTS);
    expect(pw.description).toContain("buys dried up");
  });

  it("ignores a small drop in the opposing side", () => {
    // Sells 20 -> 15 is only a 25% drop: imbalance points only.
    const pw = computePaperWeight(tape(30, 15, 10, 20), "long", AT);
    expect(pw.adjustmentPoints).toBeCloseTo(((30 - 15) / 45) * PW_IMBALANCE_MAX_POINTS, 1);
  });

  it("scores nothing on thin, missing or stale tape", () => {
    expect(computePaperWeight(tape(4, 2), "long", AT).adjustmentPoints).toBe(0);
    expect(computePaperWeight(null, "long", AT).adjustmentPoints).toBe(0);
    expect(computePaperWeight(tape(30, 10, 0, 0, 120_000), "long", AT).adjustmentPoints).toBe(0);
  });
});
