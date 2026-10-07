import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  hasReachedTrailingStopActivation,
  resolveTrailingStopDistanceTicks,
  TRAILING_STOP_ACTIVATION_R,
  TRAILING_STOP_DISTANCE_TICKS,
  TRAILING_STOP_MIN_TICKS,
} from "../src/risk/stops.js";
import { getInstrument } from "../src/marketData/instruments.js";

function d(n: number): Decimal {
  return new Decimal(n);
}

// Activation history: 0.5 of the way to target (v1.3), 0.65 (2026-09-21),
// then 1.5R in profit (2026-10-06, operator: "set a trailing stop when price
// hits 1.5R") -- measured from the trade's own stop distance, not the target.
// Cases are stated against the constant; only the last test pins its value.
describe("hasReachedTrailingStopActivation", () => {
  // Entry 100, stop 95 (5pt risk) -> long arms at 100 + 1.5 x 5 = 107.5.
  const longActivation = 100 + TRAILING_STOP_ACTIVATION_R * 5;
  // Entry 100, stop 105 -> short arms at 92.5.
  const shortActivation = 100 - TRAILING_STOP_ACTIVATION_R * 5;

  it("does not activate before price reaches 1.5R on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(95), "long", d(longActivation - 0.25), d(99))).toBe(false);
  });

  it("activates exactly at 1.5R on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(95), "long", d(longActivation), d(99))).toBe(true);
  });

  it("activates once price has moved past 1.5R on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(95), "long", d(longActivation + 2), d(99))).toBe(true);
  });

  it("does not activate before price reaches 1.5R on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(105), "short", d(101), d(shortActivation + 0.25))).toBe(false);
  });

  it("activates exactly at 1.5R on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(105), "short", d(101), d(shortActivation))).toBe(true);
  });

  it("activates once price has moved past 1.5R on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(105), "short", d(101), d(shortActivation - 2))).toBe(true);
  });

  it("is the halfway point of a 3R target", () => {
    // Entry 100, stop 95, target 115 (3R): arms at 107.5, halfway to 115.
    expect(longActivation).toBe(100 + (115 - 100) / 2);
  });

  it("never arms with a zero stop distance", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(100), "long", d(200), d(99))).toBe(false);
  });

  it("exposes the activation multiple as 1.5R", () => {
    expect(TRAILING_STOP_ACTIVATION_R).toBe(1.5);
  });
});

// 2026-09-09 (operator instruction: "a trailing stop loss with 5 ticks
// should be applied when an execution hits half way to the target tp") --
// superseded the previous flat-15-point distance (2026-08-18, converted to
// ticks per instrument), which is gone, not left dormant.
//
// 2026-09-21: no longer flat for every instrument. NQ got its own ATR-scaled
// band (operator: "the trailing stop loss is way too tight for nq it should
// be at 20 ticks to 35 at the least never less than 15") after a flat 5
// ticks -- 1.25 points on NQ -- closed essentially every trade that armed a
// trail that session. Instruments without a band are unchanged.
describe("resolveTrailingStopDistanceTicks", () => {
  const nq = getInstrument("NQ");
  const es = getInstrument("ES");

  it("keeps the flat 5 ticks for an instrument with no band", () => {
    expect(es.trailingStopTickBand).toBeUndefined();
    expect(resolveTrailingStopDistanceTicks(es, d(1.94))).toBe(TRAILING_STOP_DISTANCE_TICKS);
    expect(resolveTrailingStopDistanceTicks(es, null)).toBe(TRAILING_STOP_DISTANCE_TICKS);
  });

  it("scales NQ off half of ATR when that lands inside the band", () => {
    // ATR 10.81pts (a real reading from 2026-09-21): 0.5 x 10.81 / 0.25 tick
    // = 21.62 -> 22 ticks = 5.50 points.
    expect(resolveTrailingStopDistanceTicks(nq, d(10.81))).toBe(22);
  });

  it("clamps NQ up to the band minimum on a quiet tape", () => {
    // 0.5 x 6 / 0.25 = 12 ticks, below the 20-tick floor.
    expect(resolveTrailingStopDistanceTicks(nq, d(6))).toBe(20);
  });

  it("clamps NQ down to the band maximum on a fast tape", () => {
    // 0.5 x 30 / 0.25 = 60 ticks, above the 35-tick ceiling.
    expect(resolveTrailingStopDistanceTicks(nq, d(30))).toBe(35);
  });

  it("falls back to the band minimum, not the flat 5, when ATR is unavailable", () => {
    // Failing toward a trail we know is too wide beats failing toward one we
    // know is too tight -- see resolveTrailingStopDistanceTicks' own comment.
    expect(resolveTrailingStopDistanceTicks(nq, null)).toBe(20);
    expect(resolveTrailingStopDistanceTicks(nq, d(0))).toBe(20);
    expect(resolveTrailingStopDistanceTicks(nq, d(-1))).toBe(20);
  });

  it("never returns less than TRAILING_STOP_MIN_TICKS for a banded instrument", () => {
    // Standing invariant: even if a band minimum were later lowered below 15,
    // the floor still holds. Uses a synthetic instrument precisely because no
    // real one is configured this way today.
    const tooTight = { tickSize: d(0.25), trailingStopTickBand: { minTicks: 2, maxTicks: 8 } };
    expect(resolveTrailingStopDistanceTicks(tooTight, d(1))).toBe(TRAILING_STOP_MIN_TICKS);
    expect(resolveTrailingStopDistanceTicks(tooTight, null)).toBe(TRAILING_STOP_MIN_TICKS);
  });

  it("holds NQ inside the operator's stated 20-35 tick band across a wide ATR sweep", () => {
    for (let atr = 0.25; atr <= 60; atr += 0.25) {
      const ticks = resolveTrailingStopDistanceTicks(nq, d(atr));
      expect(ticks).toBeGreaterThanOrEqual(20);
      expect(ticks).toBeLessThanOrEqual(35);
    }
  });

  it("guards a zero tickSize without dividing by it", () => {
    const broken = { tickSize: d(0), trailingStopTickBand: { minTicks: 20, maxTicks: 35 } };
    expect(resolveTrailingStopDistanceTicks(broken, d(10))).toBe(20);
  });
});

describe("hasReachedTrailingStopActivation after a stop moves to breakeven", () => {
  it("measures R from the 3R target, so a breakeven stop doesn't disable the trail", () => {
    // Entry 100, target 115 (3R -> R = 5), stop moved to 100 (breakeven).
    expect(hasReachedTrailingStopActivation(d(100), d(100), "long", d(107.5), d(99), d(115))).toBe(true);
    expect(hasReachedTrailingStopActivation(d(100), d(100), "long", d(107.25), d(99), d(115))).toBe(false);
    expect(hasReachedTrailingStopActivation(d(100), d(100), "short", d(101), d(92.5), d(85))).toBe(true);
  });
});
