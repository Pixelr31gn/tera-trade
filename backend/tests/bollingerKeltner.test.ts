import { describe, expect, it } from "vitest";
import { computeBollingerBands } from "../src/analytics/bollingerBands.js";
import { computeKeltnerChannels } from "../src/analytics/keltnerChannels.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function makeBars(count: number, priceFn: (i: number) => number): OhlcBar[] {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  return Array.from({ length: count }, (_, i) => {
    const price = priceFn(i);
    return { time: new Date(base + i * 60_000), open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 100 };
  });
}

describe("computeBollingerBands", () => {
  it("returns null when there aren't enough bars", () => {
    expect(computeBollingerBands(makeBars(5, () => 100), 20)).toBeNull();
  });

  it("collapses to a near-zero-width band for perfectly flat prices", () => {
    const bands = computeBollingerBands(makeBars(20, () => 100), 20)!;
    expect(bands.middle).toBeCloseTo(100, 5);
    expect(bands.upper).toBeCloseTo(100, 5);
    expect(bands.lower).toBeCloseTo(100, 5);
    expect(bands.bandwidth).toBeCloseTo(0, 5);
  });

  it("widens the bands as price variance increases", () => {
    const flat = computeBollingerBands(makeBars(20, () => 100), 20)!;
    const volatile = computeBollingerBands(
      makeBars(20, (i) => 100 + (i % 2 === 0 ? 10 : -10)),
      20
    )!;
    expect(volatile.upper - volatile.lower).toBeGreaterThan(flat.upper - flat.lower);
  });

  it("keeps the middle band between upper and lower", () => {
    const bands = computeBollingerBands(makeBars(20, (i) => 100 + i), 20)!;
    expect(bands.lower).toBeLessThanOrEqual(bands.middle);
    expect(bands.middle).toBeLessThanOrEqual(bands.upper);
  });
});

describe("computeKeltnerChannels", () => {
  it("returns null when there aren't enough bars", () => {
    expect(computeKeltnerChannels(makeBars(5, () => 100), 20)).toBeNull();
  });

  it("keeps the middle line between upper and lower", () => {
    const channels = computeKeltnerChannels(makeBars(40, (i) => 100 + i * 0.1), 20)!;
    expect(channels.lower).toBeLessThanOrEqual(channels.middle);
    expect(channels.middle).toBeLessThanOrEqual(channels.upper);
  });
});
