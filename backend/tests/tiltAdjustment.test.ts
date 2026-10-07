import { describe, expect, it } from "vitest";
import type { OrderFlowSnapshot } from "../src/browserWatch/orderFlowListener.js";
import { applyTiltToProbability, computeTiltAdjustment, TILT_MAX_POINTS, TILT_SCORING_MAX_AGE_MS } from "../src/scoring/tiltAdjustment.js";

const AT = new Date("2026-10-06T14:00:00Z");

function snap(longPct: number | null, positivePct: number | null, updatedAgoMs: number | null = 10_000): OrderFlowSnapshot {
  return {
    symbol: "NQ",
    bestBidPrice: null, bestBidSize: null, bestAskPrice: null, bestAskSize: null,
    buyVolume: 0, sellVolume: 0, tradeCount: 0,
    tiltLongBias: longPct,
    tiltShortBias: longPct === null ? null : 100 - longPct,
    tiltPositivePct: positivePct,
    tiltNegativePct: positivePct === null ? null : 100 - positivePct,
    tiltUpdatedAtMs: updatedAgoMs === null ? null : AT.getTime() - updatedAgoMs,
  };
}

const pts = (l: number, p: number, side: "long" | "short") => computeTiltAdjustment(snap(l, p), side, AT).adjustmentPoints;

describe("computeTiltAdjustment -- winning side", () => {
  it("longs winning boosts longs and penalizes shorts", () => {
    expect(pts(73, 65, "long")).toBeCloseTo(7.4, 1);
    expect(pts(73, 65, "short")).toBeCloseTo(-7.4, 1);
  });

  it("longs trapped boosts shorts", () => {
    expect(pts(73, 35, "short")).toBeGreaterThan(0);
    expect(pts(73, 35, "long")).toBeLessThan(0);
  });

  it("shorts trapped boosts longs; shorts winning boosts shorts", () => {
    expect(pts(30, 35, "long")).toBeGreaterThan(0);
    expect(pts(30, 65, "short")).toBeGreaterThan(0);
  });

  it("is zero when either row is exactly even, and caps at the maximum", () => {
    expect(pts(50, 80, "long")).toBe(0);
    expect(pts(80, 50, "long")).toBe(0);
    expect(pts(100, 100, "long")).toBe(TILT_MAX_POINTS);
  });

  it("scores nothing without a fresh reading (replay, dead feed)", () => {
    expect(computeTiltAdjustment(null, "long", AT).adjustmentPoints).toBe(0);
    expect(computeTiltAdjustment(snap(70, null), "long", AT).adjustmentPoints).toBe(0);
    expect(computeTiltAdjustment(snap(70, 60, null), "long", AT).adjustmentPoints).toBe(0);
    expect(computeTiltAdjustment(snap(70, 60, TILT_SCORING_MAX_AGE_MS + 1), "long", AT).adjustmentPoints).toBe(0);
  });

  it("judges freshness against the bar time, not the wall clock", () => {
    expect(computeTiltAdjustment(snap(70, 60, -30_000), "long", AT).adjustmentPoints).toBeGreaterThan(0);
  });
});

describe("applyTiltToProbability", () => {
  it("moves a 0-1 probability by points/100 and clamps", () => {
    expect(applyTiltToProbability(0.6, { adjustmentPoints: 9.2, description: "" })).toBeCloseTo(0.692, 5);
    expect(applyTiltToProbability(0.95, { adjustmentPoints: 20, description: "" })).toBe(1);
    expect(applyTiltToProbability(0.05, { adjustmentPoints: -20, description: "" })).toBe(0);
  });
});
