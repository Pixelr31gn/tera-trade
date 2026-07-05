import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeInitialStop } from "../src/risk/stops.js";

describe("computeInitialStop", () => {
  it("uses the tighter of structure and ATR on the long side", () => {
    const plan = computeInitialStop(new Decimal(100), "long", new Decimal(2), new Decimal("98.5"), { tickSize: new Decimal("0.25") });
    expect(plan.basis).toBe("structure");
    expect(plan.stopPrice.toString()).toBe("98.5");
    expect(plan.takeProfitPrice.gt(100)).toBe(true);
  });

  it("falls back to ATR when structure is wider", () => {
    const plan = computeInitialStop(new Decimal(100), "long", new Decimal(2), new Decimal(90), { tickSize: new Decimal("0.25") });
    expect(plan.basis).toBe("atr");
    expect(plan.stopPrice.toString()).toBe(new Decimal(100).minus(new Decimal(2).times("1.5")).toString());
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
