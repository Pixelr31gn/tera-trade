import { describe, expect, it } from "vitest";
import {
  parseOccOptionSymbol,
  computeContractGex,
  computeGexByStrike,
  findGammaWalls,
  findGammaFlip,
  computeWallOutcome,
  computeGammaFlipOutcome,
  bucketOptionsByExpiration,
  type RawCboeOption,
  type ParsedOption,
} from "../src/analytics/dealerGex.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function bar(time: string, high: number, low: number, close: number): OhlcBar {
  return { time: new Date(time), open: close, high, low, close, volume: 100 };
}

describe("parseOccOptionSymbol", () => {
  it("parses a call", () => {
    expect(parseOccOptionSymbol("SPX260821C05500000")).toEqual({
      type: "call",
      strike: 5500,
      expiration: new Date(Date.UTC(2026, 7, 21)),
    });
  });

  it("parses a put with a weekly root (SPXW)", () => {
    expect(parseOccOptionSymbol("SPXW260811P07750000")).toEqual({
      type: "put",
      strike: 7750,
      expiration: new Date(Date.UTC(2026, 7, 11)),
    });
  });

  it("parses a fractional strike", () => {
    const parsed = parseOccOptionSymbol("NDX260815C29750500");
    expect(parsed?.strike).toBeCloseTo(29750.5, 5);
  });

  it("returns null for a non-matching string", () => {
    expect(parseOccOptionSymbol("not-an-option-symbol")).toBeNull();
  });
});

describe("computeContractGex", () => {
  const spot = 100;

  it("is positive for a call", () => {
    const raw: RawCboeOption = { symbol: "X", openInterest: 10, gamma: 0.05 };
    const parsed = { type: "call" as const, strike: 100, expiration: new Date() };
    // 100 * 0.05 * 10 * 100 * 100 * 0.01 = 5000
    expect(computeContractGex(raw, parsed, spot)).toBeCloseTo(5000, 5);
  });

  it("is negative for a put with identical magnitude inputs", () => {
    const raw: RawCboeOption = { symbol: "X", openInterest: 10, gamma: 0.05 };
    const parsed = { type: "put" as const, strike: 100, expiration: new Date() };
    expect(computeContractGex(raw, parsed, spot)).toBeCloseTo(-5000, 5);
  });
});

describe("computeGexByStrike", () => {
  it("aggregates multiple contracts at the same strike and keeps strikes ascending", () => {
    const spot = 100;
    const options = [
      { raw: { symbol: "a", openInterest: 10, gamma: 0.05 }, parsed: { type: "call" as const, strike: 105, expiration: new Date() } },
      { raw: { symbol: "b", openInterest: 20, gamma: 0.02 }, parsed: { type: "put" as const, strike: 95, expiration: new Date() } },
      { raw: { symbol: "c", openInterest: 5, gamma: 0.05 }, parsed: { type: "call" as const, strike: 105, expiration: new Date() } },
    ];
    const result = computeGexByStrike(options, spot);
    expect(result.map((s) => s.strike)).toEqual([95, 105]);
    // strike 105: (10+5) contracts * (100 * 0.05 * 100 * 100 * 0.01 per-contract) = 15 * 500 = 7500
    expect(result[1]!.callGex).toBeCloseTo(7500, 5);
    expect(result[1]!.netGex).toBeCloseTo(7500, 5);
  });
});

describe("findGammaWalls", () => {
  it("picks the strike with the largest positive net GEX as the call wall and largest-magnitude negative as the put wall", () => {
    const byStrike = [
      { strike: 90, callGex: 0, putGex: -2000, netGex: -2000 },
      { strike: 95, callGex: 0, putGex: -500, netGex: -500 },
      { strike: 100, callGex: 100, putGex: -100, netGex: 0 },
      { strike: 105, callGex: 3000, putGex: 0, netGex: 3000 },
      { strike: 110, callGex: 1000, putGex: 0, netGex: 1000 },
    ];
    expect(findGammaWalls(byStrike)).toEqual({ callWall: 105, putWall: 90 });
  });

  it("returns null callWall when every strike has non-positive net GEX", () => {
    const byStrike = [
      { strike: 90, callGex: 0, putGex: -100, netGex: -100 },
      { strike: 95, callGex: 0, putGex: -50, netGex: -50 },
    ];
    expect(findGammaWalls(byStrike).callWall).toBeNull();
  });

  it("returns empty result for an empty chain", () => {
    expect(findGammaWalls([])).toEqual({ callWall: null, putWall: null });
  });
});

describe("findGammaFlip", () => {
  it("interpolates the zero crossing between two straddling strikes", () => {
    const byStrike = [
      { strike: 90, callGex: 0, putGex: 0, netGex: 50 }, // cum = 50
      { strike: 100, callGex: 0, putGex: 0, netGex: 50 }, // cum = 100
      { strike: 110, callGex: 0, putGex: 0, netGex: -200 }, // cum = -100 -- single crossing, here
    ];
    // Crossing is between strike 100 (cum 100) and strike 110 (cum -100): span=-200, t=(0-100)/-200=0.5
    // flip = 100 + 0.5 * (110-100) = 105
    expect(findGammaFlip(byStrike, 105)).toBeCloseTo(105, 5);
  });

  it("returns the crossing closest to spot price when the chain crosses zero more than once", () => {
    // Cumulative: 100 -> -50 (crossing #1, between 90 and 100) -> 300 (crossing #2, between 100 and 110).
    const byStrike = [
      { strike: 90, callGex: 0, putGex: 0, netGex: 100 },
      { strike: 100, callGex: 0, putGex: 0, netGex: -150 },
      { strike: 110, callGex: 0, putGex: 0, netGex: 350 },
    ];
    // crossing #1: span=-150, t=100/150=0.6667, price=90+0.6667*10=96.67
    // crossing #2: span=350,  t=50/350=0.1429, price=100+0.1429*10=101.43
    // Spot near the second strike should pick crossing #2, not the first-encountered one.
    expect(findGammaFlip(byStrike, 101)).toBeCloseTo(101.43, 1);
    expect(findGammaFlip(byStrike, 95)).toBeCloseTo(96.67, 1);
  });

  it("returns null when cumulative GEX never changes sign", () => {
    const byStrike = [
      { strike: 90, callGex: 0, putGex: 0, netGex: 100 },
      { strike: 100, callGex: 0, putGex: 0, netGex: 50 },
      { strike: 110, callGex: 0, putGex: 0, netGex: 20 },
    ];
    expect(findGammaFlip(byStrike, 100)).toBeNull();
  });

  it("returns null for fewer than 2 strikes", () => {
    expect(findGammaFlip([{ strike: 100, callGex: 0, putGex: 0, netGex: 50 }], 100)).toBeNull();
    expect(findGammaFlip([], 100)).toBeNull();
  });
});

describe("computeWallOutcome", () => {
  it("is not_reached when price never comes near the wall", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 105, 95, 100), bar("2026-01-01T00:01:00Z", 106, 96, 101)];
    expect(computeWallOutcome(200, "call_wall", bars)).toBe("not_reached");
    expect(computeWallOutcome(50, "put_wall", bars)).toBe("not_reached");
  });

  it("is rejected when a call wall is touched but the window closes back below it", () => {
    const bars = [
      bar("2026-01-01T00:00:00Z", 95, 90, 92),
      bar("2026-01-01T00:01:00Z", 100, 98, 99), // touches 100 exactly
      bar("2026-01-01T00:02:00Z", 97, 93, 94), // closes back below
    ];
    expect(computeWallOutcome(100, "call_wall", bars)).toBe("rejected");
  });

  it("is broken when a call wall is touched and the window closes above it", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 95, 90, 92), bar("2026-01-01T00:01:00Z", 105, 99, 103)];
    expect(computeWallOutcome(100, "call_wall", bars)).toBe("broken");
  });

  it("is rejected when a put wall is touched but the window closes back above it", () => {
    const bars = [
      bar("2026-01-01T00:00:00Z", 110, 105, 108),
      bar("2026-01-01T00:01:00Z", 102, 100, 101), // touches 100 exactly
      bar("2026-01-01T00:02:00Z", 106, 103, 105), // closes back above
    ];
    expect(computeWallOutcome(100, "put_wall", bars)).toBe("rejected");
  });

  it("is broken when a put wall is touched and the window closes below it", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 110, 105, 108), bar("2026-01-01T00:01:00Z", 101, 95, 97)];
    expect(computeWallOutcome(100, "put_wall", bars)).toBe("broken");
  });

  it("is not_reached for an empty bar window", () => {
    expect(computeWallOutcome(100, "call_wall", [])).toBe("not_reached");
  });
});

describe("bucketOptionsByExpiration", () => {
  function opt(expiration: Date): { parsed: ParsedOption } {
    return { parsed: { type: "call", strike: 100, expiration } };
  }

  it("puts same-UTC-calendar-day expirations in zeroDte and everything else in structural", () => {
    const at = new Date("2026-08-11T15:00:00Z");
    const options = [
      opt(new Date("2026-08-11T00:00:00Z")), // same day, different time -- still 0DTE
      opt(new Date("2026-08-12T00:00:00Z")), // next day -- structural
      opt(new Date("2026-08-15T00:00:00Z")), // several days out -- structural
    ];
    const { zeroDte, structural } = bucketOptionsByExpiration(options, at);
    expect(zeroDte).toHaveLength(1);
    expect(structural).toHaveLength(2);
  });

  it("returns empty buckets for an empty input", () => {
    const { zeroDte, structural } = bucketOptionsByExpiration([], new Date());
    expect(zeroDte).toHaveLength(0);
    expect(structural).toHaveLength(0);
  });

  it("treats an expiration just before UTC midnight as still today, not tomorrow", () => {
    const at = new Date("2026-08-11T10:00:00Z");
    const { zeroDte } = bucketOptionsByExpiration([opt(new Date("2026-08-11T23:59:59Z"))], at);
    expect(zeroDte).toHaveLength(1);
  });
});

describe("computeGammaFlipOutcome", () => {
  it("stays_above when spot starts and ends above the flip", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 112, 108, 110)];
    expect(computeGammaFlipOutcome(100, 105, bars)).toBe("stayed_above");
  });

  it("stays_below when spot starts and ends below the flip", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 96, 92, 94)];
    expect(computeGammaFlipOutcome(100, 95, bars)).toBe("stayed_below");
  });

  it("crossed_up when spot started below the flip and the window closes above it", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 108, 96, 106)];
    expect(computeGammaFlipOutcome(100, 95, bars)).toBe("crossed_up");
  });

  it("crossed_down when spot started above the flip and the window closes below it", () => {
    const bars = [bar("2026-01-01T00:00:00Z", 106, 92, 94)];
    expect(computeGammaFlipOutcome(100, 105, bars)).toBe("crossed_down");
  });

  it("falls back to spotAtComputation when the bar window is empty (no movement to report)", () => {
    expect(computeGammaFlipOutcome(100, 105, [])).toBe("stayed_above");
    expect(computeGammaFlipOutcome(100, 95, [])).toBe("stayed_below");
  });
});
