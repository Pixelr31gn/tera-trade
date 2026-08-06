import { describe, expect, it } from "vitest";
import { computeVolumeProfile } from "../src/analytics/volumeProfile.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function bar(high: number, low: number, volume: number): OhlcBar {
  return { time: new Date("2026-01-01T00:00:00Z"), open: (high + low) / 2, high, low, close: (high + low) / 2, volume };
}

describe("computeVolumeProfile", () => {
  it("returns an empty profile for no bars", () => {
    const profile = computeVolumeProfile([], 1);
    expect(profile.levels).toEqual([]);
    expect(profile.poc).toBeNull();
  });

  it("identifies the POC as the highest-volume price bucket", () => {
    const bars = [
      bar(101, 99, 1000), // heavy volume around 100
      bar(101, 99, 1000),
      bar(201, 199, 10), // light volume around 200
    ];
    const profile = computeVolumeProfile(bars, 1);
    expect(profile.poc).not.toBeNull();
    expect(profile.poc).toBeGreaterThanOrEqual(99);
    expect(profile.poc).toBeLessThanOrEqual(101);
  });

  it("value area brackets the POC and never exceeds the full price range", () => {
    const bars = [bar(110, 90, 500)];
    const profile = computeVolumeProfile(bars, 1);
    expect(profile.valueAreaLow).not.toBeNull();
    expect(profile.valueAreaHigh).not.toBeNull();
    expect(profile.valueAreaLow!).toBeGreaterThanOrEqual(90);
    expect(profile.valueAreaHigh!).toBeLessThanOrEqual(110);
    expect(profile.valueAreaLow!).toBeLessThanOrEqual(profile.valueAreaHigh!);
  });

  it("flags a concentrated bucket as a high volume node and a sparse one as low volume", () => {
    const bars = [
      bar(101, 99, 5000), // one massively concentrated bucket
      bar(151, 149, 10),
      bar(201, 199, 10),
      bar(251, 249, 10),
    ];
    const profile = computeVolumeProfile(bars, 1);
    expect(profile.highVolumeNodes.length).toBeGreaterThan(0);
    expect(profile.lowVolumeNodes.length).toBeGreaterThan(0);
  });
});
