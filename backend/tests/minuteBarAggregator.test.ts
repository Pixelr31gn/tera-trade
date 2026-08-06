import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { MinuteBarAggregator } from "../src/marketData/minuteBarAggregator.js";

function d(n: number): Decimal {
  return new Decimal(n);
}

// Prices below are scaled to realistic ES/NQ levels (not toy round numbers
// like 100/105) so the ticks stay well under MinuteBarAggregator's own
// implausible-move rejection threshold, which is a percentage of price --
// a 5-point ES wiggle is a tiny fraction of a percent at ~7490 but would be
// a suspicious 5% jump at a toy price of 100.
describe("MinuteBarAggregator", () => {
  it("returns null while ticks stay within the same minute", () => {
    const agg = new MinuteBarAggregator();
    const t0 = new Date("2026-01-01T00:00:05Z");
    const t1 = new Date("2026-01-01T00:00:15Z");
    expect(agg.addTick("ES", d(7490), d(1), t0)).toBeNull();
    expect(agg.addTick("ES", d(7491), d(1), t1)).toBeNull();
  });

  it("returns the completed bar exactly when a tick crosses into a new minute", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(7490), d(1), new Date("2026-01-01T00:00:05Z"));
    agg.addTick("ES", d(7495), d(1), new Date("2026-01-01T00:00:20Z"));
    agg.addTick("ES", d(7488), d(1), new Date("2026-01-01T00:00:40Z"));
    agg.addTick("ES", d(7492), d(1), new Date("2026-01-01T00:00:55Z"));

    const completed = agg.addTick("ES", d(7493), d(1), new Date("2026-01-01T00:01:02Z"));
    expect(completed).not.toBeNull();
    expect(completed!.time.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(completed!.open.toNumber()).toBe(7490); // first tick in the minute
    expect(completed!.high.toNumber()).toBe(7495); // max across the minute
    expect(completed!.low.toNumber()).toBe(7488); // min across the minute
    expect(completed!.close.toNumber()).toBe(7492); // last tick in the minute
    expect(completed!.volume.toNumber()).toBe(4); // summed across 4 ticks
  });

  it("tracks each symbol's in-progress minute independently", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(7490), d(1), new Date("2026-01-01T00:00:05Z"));
    agg.addTick("NQ", d(20000), d(1), new Date("2026-01-01T00:00:05Z"));

    // ES crosses into a new minute -- NQ's in-progress bar must be unaffected.
    const esCompleted = agg.addTick("ES", d(7491), d(1), new Date("2026-01-01T00:01:00Z"));
    expect(esCompleted).not.toBeNull();

    const nqCompleted = agg.addTick("NQ", d(20001), d(1), new Date("2026-01-01T00:00:30Z"));
    expect(nqCompleted).toBeNull(); // still the same minute for NQ
  });

  it("starts a fresh in-progress bar immediately after completing the previous one", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(7490), d(1), new Date("2026-01-01T00:00:05Z"));
    const completed = agg.addTick("ES", d(7491), d(1), new Date("2026-01-01T00:01:01Z"));
    expect(completed!.open.toNumber()).toBe(7490);

    // The tick that triggered completion starts the *new* in-progress bar --
    // it should not also appear inside the just-completed bar.
    expect(completed!.close.toNumber()).toBe(7490);
  });

  it("rejects an implausible single-tick price jump instead of corrupting the bar", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(7490), d(1), new Date("2026-01-01T00:00:05Z"));
    // A bad DOM read landing far outside any realistic single-tick move
    // (2026-07-20 incident: ES briefly read as 960.78 against a real price
    // of ~7492) must be dropped, not folded into high/low/close.
    const rejectedResult = agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:00:10Z"));
    expect(rejectedResult).toBeNull();

    const completed = agg.addTick("ES", d(7491), d(1), new Date("2026-01-01T00:01:00Z"));
    expect(completed!.high.toNumber()).toBe(7490);
    expect(completed!.low.toNumber()).toBe(7490);
    expect(completed!.close.toNumber()).toBe(7490);
  });

  it("does not accept a single isolated implausible tick even after the rejection timeout", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(7490), d(1), new Date("2026-01-01T00:00:05Z"));
    agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:00:10Z")); // rejected, within timeout

    // Past the 2-minute timeout, but this is the only implausible reading --
    // nothing corroborates it, so it must still be dropped. This is the
    // exact 2026-07-21 incident: one isolated bad tick (surrounded by
    // price-extraction failures before and after it) slipped through the
    // instant the old timeout-only logic elapsed and corrupted a live bar.
    const result = agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:02:30Z"));
    expect(result).toBeNull();

    // A later, plausible tick off the real 7490 level must still complete
    // normally -- the isolated outlier must not have corrupted any state.
    const completed = agg.addTick("ES", d(7491), d(1), new Date("2026-01-01T00:03:00Z"));
    expect(completed!.close.toNumber()).toBe(7490);
  });

  it("self-heals and accepts a persistent new price only once confirmed by repeated matching ticks", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(7490), d(1), new Date("2026-01-01T00:00:05Z"));
    agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:00:10Z")); // rejected, within timeout

    // Past the timeout, and now the same new level keeps reappearing on
    // consecutive ticks -- a real gap/reopen, not a one-off scraping glitch.
    // The first two confirming ticks are still withheld (not yet enough
    // corroboration); refusing forever would silently freeze this symbol's
    // feed, which is worse than eventually accepting a confirmed real move.
    expect(agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:02:30Z"))).toBeNull(); // confirmation 1
    expect(agg.addTick("ES", d(960.5), d(1), new Date("2026-01-01T00:02:40Z"))).toBeNull(); // confirmation 2

    // Third matching tick -- now confirmed. It also crosses into a new
    // minute, so this completes the bar built from just the one legitimate
    // 7490 tick (none of the withheld ticks ever touched it).
    const completed = agg.addTick("ES", d(961), d(1), new Date("2026-01-01T00:02:50Z"));
    expect(completed).not.toBeNull();
    expect(completed!.close.toNumber()).toBe(7490);

    // The new in-progress bar now reflects the healed price.
    const nextCompleted = agg.addTick("ES", d(961.2), d(1), new Date("2026-01-01T00:03:30Z"));
    expect(nextCompleted!.open.toNumber()).toBe(961);
  });

  it("resets the confirmation count if a post-timeout implausible tick doesn't match the previous one", () => {
    const agg = new MinuteBarAggregator();
    agg.addTick("ES", d(7490), d(1), new Date("2026-01-01T00:00:05Z"));
    agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:00:10Z")); // rejected, within timeout

    // Two different, unrelated bad readings in a row -- neither corroborates
    // the other, so the confirmation count must restart, not accumulate.
    expect(agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:02:30Z"))).toBeNull(); // confirmation 1 for 960.78
    expect(agg.addTick("ES", d(2.3), d(1), new Date("2026-01-01T00:02:40Z"))).toBeNull(); // unrelated -- restarts at confirmation 1 for 2.3
    expect(agg.addTick("ES", d(960.78), d(1), new Date("2026-01-01T00:02:50Z"))).toBeNull(); // unrelated again -- restarts at confirmation 1 for 960.78

    // Still no confirmed level, so a plausible tick off the real price must
    // still complete normally.
    const completed = agg.addTick("ES", d(7491), d(1), new Date("2026-01-01T00:03:00Z"));
    expect(completed!.close.toNumber()).toBe(7490);
  });
});
