import { describe, expect, it } from "vitest";

import type { OhlcBar } from "../src/regime/indicators.js";
import { checkMaTouchExit, maTouchExitTicksFor, watchedTimeframesAtEntry } from "../src/risk/maTouchExit.js";

const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
/** 1-minute bars, oldest first, flat at each close. */
function bars(closes: number[]): OhlcBar[] {
  return closes.map((c, i) => ({ time: new Date(T0 + i * 60_000), open: c, high: c, low: c, close: c, volume: 1 }));
}
const TICK = 0.25;

describe("20 MA touch exit (2026-11-13)", () => {
  it("uses NQ 50 / ES 15 ticks", () => {
    expect(maTouchExitTicksFor("NQ")).toBe(50);
    expect(maTouchExitTicksFor("ES")).toBe(15);
    expect(maTouchExitTicksFor("GC")).toBe(15);
  });

  it("does not watch an MA that was already within range at entry", () => {
    // Every MA sits at 100 and price enters at 100 -- nothing to watch.
    expect(watchedTimeframesAtEntry(bars(Array(1500).fill(100)), 100, TICK, 15)).toEqual([]);
  });

  it("watches only the timeframes that were NOT near at entry (operator example)", () => {
    // Last 20 minutes at 110, everything before at 100: the 1m MA is 110 (near
    // a 110 entry), the 5m MA is (4x110 + 16x100)/20 = 102 -> 32 ticks away.
    const history = [...Array(1480).fill(100), ...Array(20).fill(110)];
    const watched = watchedTimeframesAtEntry(bars(history), 110, TICK, 15);
    expect(watched).not.toContain(1);
    expect(watched).toEqual([5, 15, 30, 60]);
  });

  it("fires within the tick distance on a watched MA, for longs and shorts alike", () => {
    const b = bars(Array(1500).fill(100)); // all MAs at 100
    // 15 ticks above the MA (a long that fell back toward it): fires.
    expect(checkMaTouchExit(b, 103.75, 103.75, TICK, 15, [60]).fire).toBe(true);
    // 15 ticks below (a short that rallied back toward it): fires.
    expect(checkMaTouchExit(b, 96.25, 96.25, TICK, 15, [60]).fire).toBe(true);
    // 17 ticks away: does not.
    expect(checkMaTouchExit(b, 104.25, 104.25, TICK, 15, [60]).fire).toBe(false);
    // A range that covers the MA is 0 ticks away.
    const hit = checkMaTouchExit(b, 99, 101, TICK, 15, [15]);
    expect(hit.fire).toBe(true);
    expect(hit.ticks).toBe(0);
    expect(hit.minutes).toBe(15);
  });

  it("ignores an MA that is near but not watched", () => {
    const b = bars(Array(1500).fill(100));
    expect(checkMaTouchExit(b, 100, 100, TICK, 15, []).fire).toBe(false);
  });
});
