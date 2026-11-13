import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { checkTrendStrength } from "../src/risk/trendStrengthGate.js";
import { clampTakeProfitTicks, computeInitialStop, isPastTimeExit } from "../src/risk/stops.js";
import type { RegimeResult } from "../src/regime/classifier.js";

function regime(trendLabel: RegimeResult["trendLabel"], adx: number | null): RegimeResult {
  return { trendLabel, volLabel: "normal", confidence: 0.5, features: { adx } };
}

describe("checkTrendStrength", () => {
  it("allows either side at ADX 20+ (2026-11-09: lowered from 40)", () => {
    expect(checkTrendStrength(regime("none", 42), "long").allowed).toBe(true);
    expect(checkTrendStrength(regime("down", 20), "long").allowed).toBe(true);
  });

  it("allows a strong trend in the trade's own direction", () => {
    expect(checkTrendStrength(regime("up", 36), "long").allowed).toBe(true);
    expect(checkTrendStrength(regime("down", 36), "short").allowed).toBe(true);
  });

  it("blocks ADX under 20 on either side and a missing ADX", () => {
    expect(checkTrendStrength(regime("down", 19.9), "long").allowed).toBe(false);
    expect(checkTrendStrength(regime("up", 16.3), "long").allowed).toBe(false);
    const missing = checkTrendStrength(regime("none", null), "short");
    expect(missing.allowed).toBe(false);
    expect(missing.reason).toContain("no ADX reading");
  });
});

describe("isPastTimeExit", () => {
  const entry = new Date("2026-11-08T15:00:00Z");
  it("fires at 10 minutes with no trailing stop armed", () => {
    expect(isPastTimeExit(entry, new Date("2026-11-08T15:09:59Z"), false)).toBe(false);
    expect(isPastTimeExit(entry, new Date("2026-11-08T15:10:00Z"), false)).toBe(true);
  });
  it("never fires once the trailing stop is armed", () => {
    expect(isPastTimeExit(entry, new Date("2026-11-08T16:00:00Z"), true)).toBe(false);
  });
});

describe("clampTakeProfitTicks", () => {
  const tick = new Decimal("0.25");
  it("holds a far target to 75 ticks and pulls a near one out to 30, on each side", () => {
    expect(clampTakeProfitTicks(new Decimal(20000), new Decimal(20050), "long", tick).toString()).toBe("20018.75");
    expect(clampTakeProfitTicks(new Decimal(20000), new Decimal(20002), "long", tick).toString()).toBe("20007.5");
    expect(clampTakeProfitTicks(new Decimal(20000), new Decimal(19950), "short", tick).toString()).toBe("19981.25");
    expect(clampTakeProfitTicks(new Decimal(20000), new Decimal(19998), "short", tick).toString()).toBe("19992.5");
  });
  it("leaves a target inside the band alone and uses the instrument's tick size", () => {
    expect(clampTakeProfitTicks(new Decimal(20000), new Decimal(20012.5), "long", tick).toString()).toBe("20012.5");
    expect(clampTakeProfitTicks(new Decimal(2000), new Decimal(2020), "long", new Decimal("0.1")).toString()).toBe("2007.5");
  });
});

describe("computeInitialStop widening", () => {
  it("widens the stop 1.5x, rounds up to a tick, and keeps the target at 3R of the widened stop", () => {
    // ATR 2 x 1.5 = 3pt, widened to 4.5pt.
    const long = computeInitialStop(new Decimal(100), "long", new Decimal(2), null, { tickSize: new Decimal("0.25") });
    expect(long.stopPrice.toString()).toBe("95.5");
    expect(long.takeProfitPrice.toString()).toBe("113.5");
    // ATR 1.1 x 1.5 = 1.65pt, widened to 2.475, rounded up to 2.5pt.
    const short = computeInitialStop(new Decimal(100), "short", new Decimal("1.1"), null, { tickSize: new Decimal("0.25") });
    expect(short.stopPrice.toString()).toBe("102.5");
    expect(short.takeProfitPrice.toString()).toBe("92.5");
  });

  it("leaves the stop alone with a factor of 1", () => {
    const plan = computeInitialStop(new Decimal(100), "long", new Decimal(2), null, { tickSize: new Decimal("0.25"), stopWidenFactor: new Decimal(1) });
    expect(plan.stopPrice.toString()).toBe("97");
  });
});
