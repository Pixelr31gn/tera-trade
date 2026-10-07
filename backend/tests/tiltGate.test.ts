import { describe, expect, it } from "vitest";
import type { OrderFlowSnapshot } from "../src/browserWatch/orderFlowListener.js";
import { checkTiltAlignment, tiltFavoredSide, TILT_MAX_AGE_MS } from "../src/risk/tiltGate.js";

const NOW = Date.parse("2026-10-06T13:30:00Z");

/** longPct = top row (% Long), positivePct = bottom row (% Positive). */
function snap(longPct: number | null, positivePct: number | null, updatedAgoMs: number | null = 5_000): OrderFlowSnapshot {
  return {
    symbol: "NQ",
    bestBidPrice: null, bestBidSize: null, bestAskPrice: null, bestAskSize: null,
    buyVolume: 0, sellVolume: 0, tradeCount: 0,
    tiltLongBias: longPct,
    tiltShortBias: longPct === null ? null : 100 - longPct,
    tiltPositivePct: positivePct,
    tiltNegativePct: positivePct === null ? null : 100 - positivePct,
    tiltUpdatedAtMs: updatedAgoMs === null ? null : NOW - updatedAgoMs,
  };
}

describe("tiltFavoredSide -- trade with the winning side", () => {
  const favor = (l: number, p: number) => tiltFavoredSide({ longPct: l, shortPct: 100 - l, positivePct: p, negativePct: 100 - p });

  it("crowd long and mostly positive: longs are winning -> long", () => {
    expect(favor(62, 58)).toMatchObject({ side: "long" });
    expect(favor(62, 58).read).toContain("longs are winning");
  });

  it("crowd long and mostly negative: longs are trapped -> short", () => {
    expect(favor(62, 40)).toMatchObject({ side: "short" });
    expect(favor(62, 40).read).toContain("longs are trapped");
  });

  it("crowd short and mostly positive: shorts are winning -> short", () => {
    expect(favor(38, 58)).toMatchObject({ side: "short" });
    expect(favor(38, 58).read).toContain("shorts are winning");
  });

  it("crowd short and mostly negative: shorts are trapped -> long", () => {
    expect(favor(38, 40)).toMatchObject({ side: "long" });
    expect(favor(38, 40).read).toContain("shorts are trapped");
  });

  it("favors nothing when either row is too close to call", () => {
    expect(favor(50.5, 70).side).toBeNull();
    expect(favor(70, 50.5).side).toBeNull();
  });
});

describe("checkTiltAlignment", () => {
  it("allows the favored side and blocks the other", () => {
    expect(checkTiltAlignment(snap(62, 58), "long", NOW).allowed).toBe(true);
    const blocked = checkTiltAlignment(snap(62, 58), "short", NOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.favoredSide).toBe("long");
    expect(blocked.reason).toContain("favors long, not short");
  });

  it("allows a short when longs are trapped", () => {
    expect(checkTiltAlignment(snap(73, 35), "short", NOW).allowed).toBe(true);
    expect(checkTiltAlignment(snap(73, 35), "long", NOW).allowed).toBe(false);
  });

  it("blocks neither side when a row is too even (neutral zone)", () => {
    expect(checkTiltAlignment(snap(50, 70), "long", NOW).allowed).toBe(true);
    expect(checkTiltAlignment(snap(50, 70), "short", NOW).allowed).toBe(true);
  });

  it("only blocks once both rows lean 55%+ -- a barely-leaning Tilt doesn't veto", () => {
    // The live 22:03 reading that vetoed a 70% v7 short: 51.3% long, 52.7% positive.
    const weak = checkTiltAlignment(snap(51.3, 52.7), "short", NOW);
    expect(weak.allowed).toBe(true);
    expect(weak.reason).toContain("not a clear lean");
    // A clear lean still blocks: 56% long and 57% positive -> longs winning.
    expect(checkTiltAlignment(snap(56, 57), "short", NOW).allowed).toBe(false);
    expect(checkTiltAlignment(snap(56, 57), "long", NOW).allowed).toBe(true);
  });

  it("fails closed with no reading, a missing row, or a stale reading", () => {
    expect(checkTiltAlignment(null, "long", NOW).allowed).toBe(false);
    expect(checkTiltAlignment(snap(62, null), "long", NOW).allowed).toBe(false);
    expect(checkTiltAlignment(snap(62, 58, null), "long", NOW).allowed).toBe(false);
    const stale = checkTiltAlignment(snap(62, 58, TILT_MAX_AGE_MS + 1), "long", NOW);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toContain("stale");
  });
});
