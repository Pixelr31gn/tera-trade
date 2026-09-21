import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  hasReachedTrailingStopActivation,
  resolveTrailingStopDistanceTicks,
  TRAILING_STOP_ACTIVATION_FRACTION,
  TRAILING_STOP_DISTANCE_TICKS,
  TRAILING_STOP_MIN_TICKS,
} from "../src/risk/stops.js";
import { getInstrument } from "../src/marketData/instruments.js";

function d(n: number): Decimal {
  return new Decimal(n);
}

// Activation was 0.5 from v1.3 until 2026-09-21, when the operator raised it
// to 0.65 ("the trailing stop loss should be set when the trade hits 65% of
// its tp goal"). Every case below is stated against the CONSTANT rather than
// a hardcoded 113/87, so the next change to it doesn't silently leave these
// asserting a fraction nobody uses -- only the last test pins the value.
describe("hasReachedTrailingStopActivation", () => {
  // Entry 100, target 120, fraction 0.65 -> activation at 113.
  const longActivation = 100 + TRAILING_STOP_ACTIVATION_FRACTION * 20;
  // Entry 100, target 80, fraction 0.65 -> activation at 87.
  const shortActivation = 100 - TRAILING_STOP_ACTIVATION_FRACTION * 20;

  it("does not activate before price reaches the activation point on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(longActivation - 0.25), d(101))).toBe(false);
  });

  it("activates exactly at the activation point on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(longActivation), d(101))).toBe(true);
  });

  it("activates once price has moved past the activation point on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(longActivation + 2), d(101))).toBe(true);
  });

  it("does not activate before price reaches the activation point on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(99), d(shortActivation + 0.25))).toBe(false);
  });

  it("activates exactly at the activation point on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(99), d(shortActivation))).toBe(true);
  });

  it("activates once price has moved past the activation point on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(99), d(shortActivation - 2))).toBe(true);
  });

  it("uses the bar's favorable extreme (high for long, low for short), not close", () => {
    // The low never reaches activation, but the high does -- must still activate.
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(longActivation), d(101))).toBe(true);
    // The high never reaches activation, but the low does -- must still activate.
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(99), d(shortActivation))).toBe(true);
  });

  it("requires more of the target to be earned than the old 0.5 rule did", () => {
    // Regression guard for the 2026-09-21 change specifically: a bar that
    // reached the OLD halfway point (110) must no longer arm the trail.
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(110), d(101))).toBe(false);
  });

  it("exposes the activation fraction as the expected constant", () => {
    expect(TRAILING_STOP_ACTIVATION_FRACTION).toBe(0.65);
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
