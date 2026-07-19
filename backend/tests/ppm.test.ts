import { describe, expect, it } from "vitest";
import { computePpm, type PpmTick } from "../src/analytics/ppm.js";

function tick(secondsFromStart: number, close: number): PpmTick {
  return { time: new Date(Date.UTC(2026, 0, 1, 0, 0, secondsFromStart)), close };
}

describe("computePpm", () => {
  it("returns zeros for fewer than 2 ticks", () => {
    const result = computePpm([tick(0, 100)]);
    expect(result.upPointsPerMinute).toBe(0);
    expect(result.downPointsPerMinute).toBe(0);
    expect(result.sampleCount).toBe(1);
  });

  it("splits pure upward movement into upPointsPerMinute only", () => {
    // 10 points over 60 seconds = 1 minute -> 10 points/min up, 0 down
    const ticks = [tick(0, 100), tick(60, 110)];
    const result = computePpm(ticks);
    expect(result.upPointsPerMinute).toBeCloseTo(10);
    expect(result.downPointsPerMinute).toBe(0);
    expect(result.netPointsPerMinute).toBeCloseTo(10);
  });

  it("splits pure downward movement into downPointsPerMinute only", () => {
    const ticks = [tick(0, 100), tick(60, 90)];
    const result = computePpm(ticks);
    expect(result.downPointsPerMinute).toBeCloseTo(10);
    expect(result.upPointsPerMinute).toBe(0);
    expect(result.netPointsPerMinute).toBeCloseTo(-10);
  });

  it("sums whipsaw movement separately -- a flat net change can still show high up and down speed", () => {
    // 100 -> 110 -> 100 over 2 minutes: net change 0, but 10 up + 10 down = 20 points of real movement
    const ticks = [tick(0, 100), tick(60, 110), tick(120, 100)];
    const result = computePpm(ticks);
    expect(result.upPointsPerMinute).toBeCloseTo(5); // 10 points / 2 minutes
    expect(result.downPointsPerMinute).toBeCloseTo(5);
    expect(result.netPointsPerMinute).toBeCloseTo(0);
  });

  it("caps the elapsed window at the requested windowMinutes", () => {
    // 30 minutes of data but a 15-minute window requested -- elapsed minutes should cap at 15
    const ticks = [tick(0, 100), tick(30 * 60, 130)];
    const result = computePpm(ticks, 15);
    expect(result.windowMinutes).toBe(15);
  });

  it("never divides by (near) zero for near-simultaneous ticks", () => {
    const ticks = [tick(0, 100), tick(0, 100.1)];
    const result = computePpm(ticks);
    expect(Number.isFinite(result.upPointsPerMinute)).toBe(true);
  });
});
