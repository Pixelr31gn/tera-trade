import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { ENTRY_REANCHOR_MIN_TICKS, reanchorBracketToRealEntry } from "../src/risk/stops.js";
import { FILL_PLAUSIBILITY_FRACTION, getInstrument } from "../src/marketData/instruments.js";

/**
 * 2026-09-21, operator decision: "trigger threshold 2 ticks or more to
 * reancor," plus an explicit yes to re-placing the real resting take-profit
 * order rather than only correcting our own record.
 *
 * engine/loop.ts's maybeReanchorToRealEntry is DB- and broker-coupled, so what
 * is tested here is the decision arithmetic it runs before it touches
 * anything: does this reading get believed at all, and is it far enough from
 * our record to be worth cancelling a live order over. Those two predicates
 * are the whole of the risk in that method -- everything after them is
 * bookkeeping.
 */
describe("mid-trade entry re-anchor decision", () => {
  const nq = getInstrument("NQ");
  const es = getInstrument("ES");

  /** Mirrors maybeReanchorToRealEntry's own two guards, in the same order. */
  function decide(symbol: string, recordedEntry: Decimal, brokerEntry: Decimal): "implausible" | "too-small" | "reanchor" {
    const instrument = getInstrument(symbol);
    const deviation = brokerEntry.minus(recordedEntry).abs();
    const tolerance = Decimal.max(instrument.maxFillDeviationPoints, recordedEntry.abs().times(FILL_PLAUSIBILITY_FRACTION));
    if (deviation.gt(tolerance)) return "implausible";
    if (deviation.lt(instrument.tickSize.times(ENTRY_REANCHOR_MIN_TICKS))) return "too-small";
    return "reanchor";
  }

  it("uses a 2-tick threshold", () => {
    expect(ENTRY_REANCHOR_MIN_TICKS).toBe(2);
  });

  it("ignores a disagreement under 2 ticks -- that is our own rounding", () => {
    // NQ tick 0.25 -> 2 ticks is 0.50.
    expect(decide("NQ", new Decimal(30800), new Decimal("30800.25"))).toBe("too-small");
    expect(decide("NQ", new Decimal(30800), new Decimal("30799.75"))).toBe("too-small");
  });

  it("re-anchors at exactly 2 ticks, in both directions", () => {
    expect(decide("NQ", new Decimal(30800), new Decimal("30800.50"))).toBe("reanchor");
    expect(decide("NQ", new Decimal(30800), new Decimal("30799.50"))).toBe("reanchor");
  });

  it("re-anchors on the real slippage seen live today", () => {
    // ES trade 32: recorded 7837.00, real fill 7843.50 (6.50 points).
    expect(decide("ES", new Decimal(7837), new Decimal("7843.5"))).toBe("reanchor");
    // NQ trades anchored 18-34 points from their real fills.
    expect(decide("NQ", new Decimal(30780), new Decimal(30798))).toBe("reanchor");
    expect(decide("NQ", new Decimal("30757.75"), new Decimal("30791.75"))).toBe("reanchor");
  });

  it("refuses to re-anchor a live bracket onto a misread", () => {
    // The 2026-09-21 ES feed corruption: 201.84 scraped for a ~7840 instrument.
    expect(decide("ES", new Decimal(7837), new Decimal("201.84"))).toBe("implausible");
    // A timestamp fragment (2026-07-28 incident shape).
    expect(decide("ES", new Decimal(7837), new Decimal("0.991"))).toBe("implausible");
    // Another symbol's price read out of the wrong row.
    expect(decide("ES", new Decimal(7837), new Decimal(30800))).toBe("implausible");
  });

  it("keeps the plausibility band wide enough that genuine slippage is never called a misread", () => {
    // 1% of ES is ~78 points, of NQ ~308 -- far beyond any real fill gap, far
    // short of every misread class above. This is the balance that the earlier
    // tight absolute tolerance got wrong (it rejected a real 6.50pt ES fill).
    expect(decide("ES", new Decimal(7837), new Decimal(7837 + 20))).toBe("reanchor");
    expect(decide("NQ", new Decimal(30800), new Decimal(30800 + 64))).toBe("reanchor");
    expect(es.maxFillDeviationPoints.lt(new Decimal(7837).times(FILL_PLAUSIBILITY_FRACTION))).toBe(true);
    expect(nq.maxFillDeviationPoints.lt(new Decimal(30800).times(FILL_PLAUSIBILITY_FRACTION))).toBe(true);
  });

  it("preserves both distances when it does re-anchor, so the ratio is untouched", () => {
    // ES trade 32's real numbers: a 4.50/13.50 plan that became 11.00/7.00 on
    // the live position because nothing re-anchored it.
    const recorded = new Decimal(7837);
    const real = new Decimal("7843.5");
    expect(decide("ES", recorded, real)).toBe("reanchor");

    const r = reanchorBracketToRealEntry(recorded, real, new Decimal("7832.5"), new Decimal("7850.5"));
    const risk = real.minus(r.stopPrice);
    const reward = r.takeProfitPrice!.minus(real);
    expect(risk.toString()).toBe("4.5");
    expect(reward.toString()).toBe("13.5");
    expect(reward.gt(risk)).toBe(true);
  });
});
