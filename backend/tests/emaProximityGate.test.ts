import { describe, expect, it } from "vitest";
import { checkChartMaProximity, checkEmaProximity, checkMultiTimeframeMaProximity } from "../src/risk/emaProximityGate.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const START = Date.UTC(2026, 10, 8, 0, 0, 0);

function bars(prices: number[]): OhlcBar[] {
  return prices.map((close, i) => ({ time: new Date(START + i * 60_000), open: close, high: close, low: close, close, volume: 1 }));
}

describe("checkEmaProximity", () => {
  // 150 flat 1-minute bars at 5000 -> thirty 5m bars, EMA20 = 5000 until the last bar moves.
  const flat = Array.from({ length: 149 }, () => 5000);

  it("allows an entry at exactly 15 ticks from the 20 EMA", () => {
    // The last 5m bar's close moves the EMA by 2/21 of the move, so solve for 15 ticks after that.
    const move = (15 * 0.25) / (1 - 2 / 21);
    expect(checkEmaProximity(bars([...flat, 5000 + move]), 0.25).allowed).toBe(true);
    expect(checkEmaProximity(bars([...flat, 5000 - move]), 0.25).allowed).toBe(true);
  });

  it("blocks an entry more than 15 ticks away on either side", () => {
    const move = (16 * 0.25) / (1 - 2 / 21);
    const above = checkEmaProximity(bars([...flat, 5000 + move]), 0.25);
    expect(above.allowed).toBe(false);
    expect(above.reason).toContain("16.0 ticks");
    expect(checkEmaProximity(bars([...flat, 5000 - move]), 0.25).allowed).toBe(false);
  });

  it("uses the instrument's tick size", () => {
    // 2.0 points away (~1.81 after the EMA moves) is ~18 ticks on a 0.1 tick but ~7 on a 0.25 tick.
    expect(checkEmaProximity(bars([...flat, 5002]), 0.25).allowed).toBe(true);
    expect(checkEmaProximity(bars([...flat, 5002]), 0.1).allowed).toBe(false);
  });

  it("fails closed without twenty 5-minute bars", () => {
    const check = checkEmaProximity(bars(Array.from({ length: 60 }, () => 5000)), 0.25);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("need 20");
  });
});

describe("checkChartMaProximity", () => {
  const now = Date.UTC(2026, 10, 11, 15, 0, 0);
  const read = (price: number, ma: number, ageMin = 1) => ({ ma, price, barTimeSec: (now - ageMin * 60_000) / 1000, resolution: "5", chartSymbol: "MNQZ26" });

  it("allows within 15 ticks of the chart MA and blocks past it", () => {
    expect(checkChartMaProximity(read(20003.75, 20000), 0.25, now).allowed).toBe(true);
    const far = checkChartMaProximity(read(20004, 20000), 0.25, now);
    expect(far.allowed).toBe(false);
    expect(far.reason).toContain("16.0 ticks from the TopstepX MNQZ26 5m MA20");
  });

  it("fails closed when the chart's last bar is stale", () => {
    const stale = checkChartMaProximity(read(20000, 20000, 20), 0.25, now);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toContain("chart not updating");
  });
});

describe("checkMultiTimeframeMaProximity (2 of 1m/5m/15m/30m/1h)", () => {
  // 1,260 one-minute bars: flat at 5000, then the last 20 minutes at 5010.
  // 1m MA = 5010 (0 ticks); 5m MA = (16x5000 + 4x5010)/20 = 5002 (32 ticks); higher TFs closer to 5000.
  const n = 1260;
  const start = Date.UTC(2026, 10, 11, 0, 0, 0);
  const prices = Array.from({ length: n }, (_, i) => (i >= n - 20 ? 5010 : 5000));
  const series = bars(prices).map((b, i) => ({ ...b, time: new Date(start + i * 60_000) }));
  const now = start + (n - 1) * 60_000 + 30_000;

  it("blocks when price is near only one MA", () => {
    const check = checkMultiTimeframeMaProximity(series, 0.25, now);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("1/5 MAs");
  });

  it("allows when a chart reading puts a second MA in range", () => {
    const check = checkMultiTimeframeMaProximity(series, 0.25, now, { minutes: 5, ma: 5008 });
    expect(check.allowed).toBe(true);
    expect(check.reason).toContain("2/5 MAs");
    expect(check.reason).toContain("5m (TopstepX chart) 5008.00");
  });

  it("counts a timeframe without 20 buckets as not near, and fails closed on stale bars", () => {
    const short = series.slice(-100); // 1h has only 2 buckets
    expect(checkMultiTimeframeMaProximity(short, 0.25, now).reason).toContain("1h n/a");
    const stale = checkMultiTimeframeMaProximity(series, 0.25, now + 20 * 60_000);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toContain("not updating");
  });
});

describe("emaProximityMaxTicksFor", () => {
  it("gives NQ 45 ticks and everything else the 15-tick default (2026-11-11)", async () => {
    const { emaProximityMaxTicksFor } = await import("../src/risk/emaProximityGate.js");
    expect(emaProximityMaxTicksFor("NQ")).toBe(45);
    expect(emaProximityMaxTicksFor("ES")).toBe(15);
    expect(emaProximityMaxTicksFor("GC")).toBe(15);
  });
});
