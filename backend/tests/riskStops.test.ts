import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeInitialStop, STOP_DISTANCE_WIDEN_FACTOR } from "../src/risk/stops.js";

describe("computeInitialStop", () => {
  it("uses the tighter of structure and ATR on the long side", () => {
    const plan = computeInitialStop(new Decimal(100), "long", new Decimal(2), new Decimal("98.5"), { tickSize: new Decimal("0.25") });
    expect(plan.basis).toBe("structure");
    // Structure stop 1.5pt, widened by STOP_DISTANCE_WIDEN_FACTOR (1.5) to 2.25pt (2026-11-08).
    expect(plan.stopPrice.toString()).toBe("97.75");
    expect(plan.takeProfitPrice.gt(100)).toBe(true);
  });

  it("falls back to ATR when structure is wider", () => {
    const plan = computeInitialStop(new Decimal(100), "long", new Decimal(2), new Decimal(90), { tickSize: new Decimal("0.25") });
    expect(plan.basis).toBe("atr");
    expect(plan.stopPrice.toString()).toBe(new Decimal(100).minus(new Decimal(2).times("1.5").times(STOP_DISTANCE_WIDEN_FACTOR)).toString());
  });

  it("flips direction for the short side", () => {
    const plan = computeInitialStop(new Decimal(100), "short", new Decimal(2), null, { tickSize: new Decimal("0.25") });
    expect(plan.stopPrice.gt(100)).toBe(true);
    expect(plan.takeProfitPrice.lt(100)).toBe(true);
  });

  it("derives trail ticks from ATR and tick size", () => {
    const plan = computeInitialStop(new Decimal(100), "long", new Decimal(1), null, {
      tickSize: new Decimal("0.25"),
      chandelierAtrMultiplier: new Decimal(3),
    });
    expect(plan.trailTicks).toBe(12); // 1 * 3 / 0.25
  });
});
