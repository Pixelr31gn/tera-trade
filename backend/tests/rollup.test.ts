import { describe, expect, it } from "vitest";
import { aggregateBarsIntoBuckets, bucketStart } from "../src/marketData/rollup.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function bar(minutesFromEpoch: number, open: number, high: number, low: number, close: number, volume = 100): OhlcBar {
  return { time: new Date(minutesFromEpoch * 60_000), open, high, low, close, volume };
}

describe("bucketStart", () => {
  it("floors to the start of the resolution's bucket", () => {
    // minute 7 at a 5-minute resolution belongs to the [5,10) bucket
    expect(bucketStart(new Date(7 * 60_000), 5).getTime()).toBe(5 * 60_000);
    expect(bucketStart(new Date(0), 5).getTime()).toBe(0);
    expect(bucketStart(new Date(4 * 60_000), 5).getTime()).toBe(0);
  });
});

describe("aggregateBarsIntoBuckets", () => {
  it("aggregates OHLC correctly within one bucket", () => {
    const bars = [bar(0, 100, 102, 99, 101), bar(1, 101, 105, 100, 103), bar(2, 103, 104, 98, 99)];
    const buckets = aggregateBarsIntoBuckets(bars, 5, new Date(0));
    expect(buckets.size).toBe(1);
    const agg = buckets.get(0)!;
    expect(agg.open).toBe(100); // first bar's open
    expect(agg.high).toBe(105); // max high across all 3
    expect(agg.low).toBe(98); // min low across all 3
    expect(agg.close).toBe(99); // last bar's close
  });

  it("sums volume across bars in the same bucket", () => {
    const bars = [bar(0, 100, 101, 99, 100, 50), bar(1, 100, 101, 99, 100, 75)];
    const buckets = aggregateBarsIntoBuckets(bars, 5, new Date(0));
    expect(buckets.get(0)!.volume).toBe(125);
  });

  it("splits bars across bucket boundaries correctly", () => {
    const bars = [bar(4, 100, 101, 99, 100), bar(5, 200, 201, 199, 200)]; // minute 4 -> bucket 0, minute 5 -> bucket 1 (5-min resolution)
    const buckets = aggregateBarsIntoBuckets(bars, 5, new Date(0));
    expect(buckets.size).toBe(2);
    expect(buckets.get(0)!.close).toBe(100);
    expect(buckets.get(5 * 60_000)!.close).toBe(200);
  });

  it("excludes a bucket whose start falls before `since` -- the bug fix", () => {
    // A 5-minute bucket starting at minute 0 (spans [0,5)), but `since` is
    // minute 2 -- meaning bars for minutes 0-1 of this bucket are missing
    // from the window, so the bucket is incomplete and must be excluded
    // rather than upserted with a wrong (partial) high/low/volume.
    const bars = [bar(2, 150, 151, 149, 150), bar(3, 150, 160, 140, 155)]; // only the tail of the [0,5) bucket
    const since = new Date(2 * 60_000);
    const buckets = aggregateBarsIntoBuckets(bars, 5, since);
    expect(buckets.has(0)).toBe(false);
  });

  it("keeps a bucket whose start is exactly at or after `since`", () => {
    const bars = [bar(5, 100, 101, 99, 100), bar(6, 100, 102, 98, 101)];
    const since = new Date(5 * 60_000);
    const buckets = aggregateBarsIntoBuckets(bars, 5, since);
    expect(buckets.has(5 * 60_000)).toBe(true);
  });

  it("still includes the newest, still-forming bucket even though it's incomplete", () => {
    // The forming bucket's start (10) is still >= since (0) -- it's expected
    // to look partial because it hasn't finished yet, not because data is
    // missing from before the query window.
    const bars = [bar(10, 100, 101, 99, 100)];
    const buckets = aggregateBarsIntoBuckets(bars, 5, new Date(0));
    expect(buckets.has(10 * 60_000)).toBe(true);
  });

  it("returns an empty map for no bars", () => {
    expect(aggregateBarsIntoBuckets([], 5, new Date(0)).size).toBe(0);
  });
});
