import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { computeSmartEntryPrice } from "../src/analytics/smartEntry.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const BASE_TIME = new Date("2026-01-01T00:00:00Z"); // exact 5-minute boundary
const ATR = new Decimal("20"); // bucketSize = max(20/20, tickSize) = max(1, tickSize)
const TICK = new Decimal("0.25");

/** 6 flat one-minute-bar candles (5 one-minute bars each) -- one price/volume pair per candle, spread evenly across its 5 bars so the resulting 5-minute aggregate is a single flat OHLC at that price with that total volume. */
function buildBars(candles: Array<{ price: number; totalVolume: number }>): OhlcBar[] {
  const bars: OhlcBar[] = [];
  candles.forEach((c, candleIndex) => {
    const perBarVolume = c.totalVolume / 5;
    for (let i = 0; i < 5; i++) {
      const minute = candleIndex * 5 + i;
      bars.push({ time: new Date(BASE_TIME.getTime() + minute * 60_000), open: c.price, high: c.price, low: c.price, close: c.price, volume: perBarVolume });
    }
  });
  return bars;
}

describe("computeSmartEntryPrice", () => {
  it("falls back to the signal price when fewer than 6 five-minute candles are available", () => {
    const bars = buildBars([{ price: 100, totalVolume: 50 }]); // only 1 candle worth
    const result = computeSmartEntryPrice(bars, "long", new Decimal("100"), ATR, TICK, null);
    expect(result.basis).toBe("signal_price");
    expect(result.entryPrice.toNumber()).toBe(100);
  });

  it("long: uses the volume point of control when it's a favorable discount vs the signal price", () => {
    // Candle 3 (price 102) has by far the most volume -> POC = 102, which is
    // <= the 105 signal price (a discount) -- clearly favorable.
    const bars = buildBars([
      { price: 100, totalVolume: 50 },
      { price: 101, totalVolume: 50 },
      { price: 102, totalVolume: 200 },
      { price: 103, totalVolume: 50 },
      { price: 104, totalVolume: 50 },
      { price: 105, totalVolume: 50 },
    ]);
    const result = computeSmartEntryPrice(bars, "long", new Decimal("105"), ATR, TICK, null);
    expect(result.basis).toBe("poc");
    expect(result.entryPrice.toNumber()).toBeCloseTo(102, 5);
  });

  it("short: uses the volume point of control when it's a favorable premium vs the signal price", () => {
    // Candle 3 (price 110) has by far the most volume -> POC = 110, which is
    // >= the 105 signal price (a premium) -- favorable for a short.
    const bars = buildBars([
      { price: 106, totalVolume: 50 },
      { price: 108, totalVolume: 50 },
      { price: 110, totalVolume: 200 },
      { price: 112, totalVolume: 50 },
      { price: 114, totalVolume: 50 },
      { price: 116, totalVolume: 50 },
    ]);
    const result = computeSmartEntryPrice(bars, "short", new Decimal("105"), ATR, TICK, null);
    expect(result.basis).toBe("poc");
    expect(result.entryPrice.toNumber()).toBeCloseTo(110, 5);
  });

  it("long: falls through to VWAP when the POC itself is unfavorable but the volume-weighted average is favorable", () => {
    // POC = 96 (single largest bucket, 30 volume, just above the 95 signal
    // price -- unfavorable). But five OTHER candles at 90-94 (125 volume
    // combined) pull the volume-weighted average (VWAP) down to ~92.8,
    // which IS favorable (<= 95). Hand-computed:
    //   sum = 25*(90+91+92+93+94) + 96*30 = 11500 + 2880 = 14380
    //   vwap = 14380 / 155 ~= 92.774
    const bars = buildBars([
      { price: 90, totalVolume: 25 },
      { price: 91, totalVolume: 25 },
      { price: 92, totalVolume: 25 },
      { price: 93, totalVolume: 25 },
      { price: 94, totalVolume: 25 },
      { price: 96, totalVolume: 30 },
    ]);
    const result = computeSmartEntryPrice(bars, "long", new Decimal("95"), ATR, TICK, null);
    expect(result.basis).toBe("vwap");
    expect(result.entryPrice.toNumber()).toBeCloseTo(92.75, 1); // 92.774 rounded to the nearest 0.25 tick
  });

  it("falls back to the signal price when neither POC nor VWAP offers a favorable price", () => {
    // Every candle sits ABOVE the signal price for a long -- no discount
    // anywhere in the window, so both POC and VWAP are rejected.
    const bars = buildBars([
      { price: 110, totalVolume: 50 },
      { price: 111, totalVolume: 50 },
      { price: 112, totalVolume: 200 },
      { price: 113, totalVolume: 50 },
      { price: 114, totalVolume: 50 },
      { price: 115, totalVolume: 50 },
    ]);
    const result = computeSmartEntryPrice(bars, "long", new Decimal("100"), ATR, TICK, null);
    expect(result.basis).toBe("signal_price");
    expect(result.entryPrice.toNumber()).toBe(100);
  });

  it("never rests beyond the structural stop reference, even when that price would otherwise be favorable", () => {
    // POC (102) is a favorable discount vs the 105 signal price, but the
    // structureSwingPrice (103) sits BETWEEN the signal and the POC -- resting
    // at 102 would put the stop on the wrong side of it, so this candidate
    // must be rejected even though it clears the plain signal-price check.
    const bars = buildBars([
      { price: 100, totalVolume: 50 },
      { price: 101, totalVolume: 50 },
      { price: 102, totalVolume: 200 },
      { price: 103, totalVolume: 50 },
      { price: 104, totalVolume: 50 },
      { price: 105, totalVolume: 50 },
    ]);
    const result = computeSmartEntryPrice(bars, "long", new Decimal("105"), ATR, TICK, new Decimal("103"));
    expect(result.basis).not.toBe("poc");
  });

  it("rounds the result to the nearest tick", () => {
    const bars = buildBars([
      { price: 100.1, totalVolume: 50 },
      { price: 101.1, totalVolume: 50 },
      { price: 102.13, totalVolume: 200 },
      { price: 103.1, totalVolume: 50 },
      { price: 104.1, totalVolume: 50 },
      { price: 105.1, totalVolume: 50 },
    ]);
    const result = computeSmartEntryPrice(bars, "long", new Decimal("105.1"), ATR, TICK, null);
    // 102.13 / 0.25 = 408.52 -> rounds to 409 -> * 0.25 = 102.25
    const remainder = result.entryPrice.dividedBy(TICK).modulo(1);
    expect(remainder.toNumber()).toBe(0);
  });
});
