import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { hasReachedTrailingStopActivation, TRAILING_STOP_ACTIVATION_FRACTION, TRAILING_STOP_DISTANCE_TICKS } from "../src/risk/stops.js";

function d(n: number): Decimal {
  return new Decimal(n);
}

describe("hasReachedTrailingStopActivation", () => {
  it("does not activate before price reaches halfway to target on a long", () => {
    // Entry 100, target 120 -> halfway is 110.
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(109.75), d(109))).toBe(false);
  });

  it("activates exactly at the halfway point on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(110), d(109))).toBe(true);
  });

  it("activates once price has moved past halfway on a long", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(115), d(112))).toBe(true);
  });

  it("does not activate before price reaches halfway to target on a short", () => {
    // Entry 100, target 80 -> halfway is 90.
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(91), d(90.25))).toBe(false);
  });

  it("activates exactly at the halfway point on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(91), d(90))).toBe(true);
  });

  it("activates once price has moved past halfway on a short", () => {
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(88), d(85))).toBe(true);
  });

  it("uses the bar's favorable extreme (high for long, low for short), not close", () => {
    // The low never reaches halfway, but the high does -- must still activate.
    expect(hasReachedTrailingStopActivation(d(100), d(120), "long", d(111), d(101))).toBe(true);
    // The high never reaches halfway, but the low does -- must still activate.
    expect(hasReachedTrailingStopActivation(d(100), d(80), "short", d(99), d(89))).toBe(true);
  });

  it("exposes the activation fraction and tick distance as the expected v1.3 constants", () => {
    expect(TRAILING_STOP_ACTIVATION_FRACTION).toBe(0.5);
    expect(TRAILING_STOP_DISTANCE_TICKS).toBe(30);
  });
});
