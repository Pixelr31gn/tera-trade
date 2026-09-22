import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { reanchorBracketToRealEntry } from "../src/risk/stops.js";

function d(n: number | string): Decimal {
  return new Decimal(n);
}

/**
 * 2026-09-21, operator instruction: "defently fix the stop_price and
 * take_profit_price issue until its resolved."
 *
 * engine/loop.ts corrects Trade.entryPrice from TopstepX's own Trade History
 * in two places (closeTrade and reconcileBrokerFlatTrade) and neither moved
 * the bracket with it, so a correctly sized 1:3 plan could end up stored as
 * risking more than it stood to make. The distances are the invariant here,
 * not the prices.
 */
describe("reanchorBracketToRealEntry", () => {
  it("preserves both distances exactly when the entry moves up", () => {
    const r = reanchorBracketToRealEntry(d(7837), d("7843.5"), d("7832.5"), d("7850.5"));
    expect(r.offset.toString()).toBe("6.5");
    // Was 4.50 risk / 13.50 reward around 7837; must still be 4.50 / 13.50
    // around 7843.50.
    expect(d("7843.5").minus(r.stopPrice).toString()).toBe("4.5");
    expect(r.takeProfitPrice!.minus(d("7843.5")).toString()).toBe("13.5");
  });

  it("preserves both distances exactly when the entry moves down", () => {
    const r = reanchorBracketToRealEntry(d(30000), d("29988.25"), d("29978"), d("30066"));
    expect(r.offset.toString()).toBe("-11.75");
    expect(d("29988.25").minus(r.stopPrice).toString()).toBe("22");
    expect(r.takeProfitPrice!.minus(d("29988.25")).toString()).toBe("66");
  });

  it("is a no-op on a zero offset", () => {
    const r = reanchorBracketToRealEntry(d(100), d(100), d(99), d(103));
    expect(r.offset.isZero()).toBe(true);
    expect(r.stopPrice.toString()).toBe("99");
    expect(r.takeProfitPrice!.toString()).toBe("103");
  });

  it("leaves a null target null", () => {
    const r = reanchorBracketToRealEntry(d(100), d(105), d(99), null);
    expect(r.takeProfitPrice).toBeNull();
    expect(r.stopPrice.toString()).toBe("104");
  });

  it("works the same for a short, where the bracket sits the other way round", () => {
    // Short: stop above entry, target below.
    const r = reanchorBracketToRealEntry(d(30000), d("30009.5"), d("30022"), d("29934"));
    expect(r.stopPrice.minus(d("30009.5")).toString()).toBe("22");
    expect(d("30009.5").minus(r.takeProfitPrice!).toString()).toBe("66");
  });

  /**
   * The three real closed trades from the 2026-09-21 Asian session whose
   * stored risk:reward had rotted to <= 1.00 while the one still-open trade
   * read a clean 2.98. Exact stop/target values are not recoverable after the
   * fact (the rows were already rewritten), so these assert the property that
   * was violated rather than specific prices: whatever ratio the plan had, the
   * re-anchor must preserve it.
   */
  it("preserves the ratio a plan was built with, at any slippage", () => {
    const plannedRisk = d(28);
    const plannedReward = d("83.5");
    const plannedEntry = d(30800);

    for (const slip of ["-64", "-22.25", "-6.5", "0", "6.5", "18", "34", "64"]) {
      const realEntry = plannedEntry.plus(slip);
      const r = reanchorBracketToRealEntry(
        plannedEntry,
        realEntry,
        plannedEntry.minus(plannedRisk),
        plannedEntry.plus(plannedReward)
      );
      const risk = realEntry.minus(r.stopPrice);
      const reward = r.takeProfitPrice!.minus(realEntry);
      expect(risk.toString(), `slip ${slip}`).toBe(plannedRisk.toString());
      expect(reward.toString(), `slip ${slip}`).toBe(plannedReward.toString());
      // And the operator's absolute rule survives the correction.
      expect(reward.gt(risk), `slip ${slip}`).toBe(true);
    }
  });

  it("would have kept the three inverted Asian-session rows the right way up", () => {
    // Each pair is (recorded entry, real entry) reproducing roughly the
    // observed slippage; the plan itself is a normal 28/83.5 NQ bracket.
    const cases: [string, string][] = [
      ["30866", "30877.5"],
      ["30909.5", "30876.5"],
      ["30909.25", "30869.75"],
    ];
    for (const [recorded, real] of cases) {
      const r = reanchorBracketToRealEntry(d(recorded), d(real), d(recorded).minus(28), d(recorded).plus("83.5"));
      const risk = d(real).minus(r.stopPrice);
      const reward = r.takeProfitPrice!.minus(d(real));
      expect(reward.gt(risk), `${recorded} -> ${real}`).toBe(true);
      expect(risk.toString()).toBe("28");
      expect(reward.toString()).toBe("83.5");
    }
  });
});
