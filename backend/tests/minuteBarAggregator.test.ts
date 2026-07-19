import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { MinuteBarAggregator } from "../src/marketData/minuteBarAggregator.js";

function d(n: number): Decimal {
  return new Decimal(n);
}

describe("MinuteBarAggregator", () => {
  it("returns null while ticks stay within the same minute", () => {
    const agg = new MinuteBarAggregator();
    const t0 = new Date("2026-01-01T00:00:05Z");
    const t1 = new Date("2026-01-01T00:00:15Z");
    expect(agg.addTick("ES", d(100), d(1), t0)).toBeNull();
    expect(agg.addTick("ES", d(101), d(1), t1)).toBeNull();
  });

  it("returns the completed bar exactly when a tick crosses into a new minute", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(100), d(1), new Date("2026-01-01T00:00:05Z"));
    agg.addTick("ES", d(105), d(1), new Date("2026-01-01T00:00:20Z"));
    agg.addTick("ES", d(98), d(1), new Date("2026-01-01T00:00:40Z"));
    agg.addTick("ES", d(102), d(1), new Date("2026-01-01T00:00:55Z"));

    const completed = agg.addTick("ES", d(103), d(1), new Date("2026-01-01T00:01:02Z"));
    expect(completed).not.toBeNull();
    expect(completed!.time.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(completed!.open.toNumber()).toBe(100); // first tick in the minute
    expect(completed!.high.toNumber()).toBe(105); // max across the minute
    expect(completed!.low.toNumber()).toBe(98); // min across the minute
    expect(completed!.close.toNumber()).toBe(102); // last tick in the minute
    expect(completed!.volume.toNumber()).toBe(4); // summed across 4 ticks
  });

  it("tracks each symbol's in-progress minute independently", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(100), d(1), new Date("2026-01-01T00:00:05Z"));
    agg.addTick("NQ", d(20000), d(1), new Date("2026-01-01T00:00:05Z"));

    // ES crosses into a new minute -- NQ's in-progress bar must be unaffected.
    const esCompleted = agg.addTick("ES", d(101), d(1), new Date("2026-01-01T00:01:00Z"));
    expect(esCompleted).not.toBeNull();

    const nqCompleted = agg.addTick("NQ", d(20001), d(1), new Date("2026-01-01T00:00:30Z"));
    expect(nqCompleted).toBeNull(); // still the same minute for NQ
  });

  it("starts a fresh in-progress bar immediately after completing the previous one", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(100), d(1), new Date("2026-01-01T00:00:05Z"));
    const completed = agg.addTick("ES", d(101), d(1), new Date("2026-01-01T00:01:01Z"));
    expect(completed!.open.toNumber()).toBe(100);

    // The tick that triggered completion starts the *new* in-progress bar --
    // it should not also appear inside the just-completed bar.
    expect(completed!.close.toNumber()).toBe(100);
  });
});
