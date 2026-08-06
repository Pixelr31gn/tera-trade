import { describe, expect, it } from "vitest";
import { atr, trueRange, type OhlcBar } from "../src/regime/indicators.js";

function bar(close: number, high = close, low = close): OhlcBar {
  return { time: new Date(), open: close, high, low, close, volume: 100 };
}

// A realistic, gently-moving series so true range stays in a small, normal
// band -- the baseline every outlier-clipping test compares against.
function normalSeries(n: number, base = 100): OhlcBar[] {
  const bars: OhlcBar[] = [];
  for (let i = 0; i < n; i++) {
    const c = base + Math.sin(i / 3) * 0.5;
    bars.push(bar(c, c + 0.25, c - 0.25));
  }
  return bars;
}

describe("trueRange -- outlier clipping", () => {
  it("leaves normal, well-behaved bars completely untouched", () => {
    const bars = normalSeries(30);
    const raw = bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      return Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close));
    });
    const clipped = trueRange(bars);
    for (let i = 0; i < bars.length; i++) {
      expect(clipped[i]).toBeCloseTo(raw[i]!, 6);
    }
  });

  it("clips a single degenerate bar's true range instead of letting it dominate", () => {
    const bars = normalSeries(20);
    // A bad tick: a single bar reads far below the real price, with the next
    // bar's own true range also inflated via prevClose (2026-07-21 NQ
    // incident: bar read as 28.782 against a real price around 29290).
    bars.push(bar(1));
    bars.push(bar(100.2));

    const clipped = trueRange(bars);
    const badBarTr = clipped[20]!;
    const nextBarTr = clipped[21]!;

    // Raw true range for the bad bar would be ~99; clipped, it must stay a
    // small multiple of the recent normal true-range level, not the raw gap.
    expect(badBarTr).toBeLessThan(20);
    expect(nextBarTr).toBeLessThan(20);
  });

  it("still lets a real, moderate volatility spike through mostly unclipped", () => {
    const bars = normalSeries(20);
    // A genuine, real gap -- a few points on a ~100-level instrument, not
    // the thousands-of-points scale of a data-feed glitch.
    bars.push(bar(105));

    const clipped = trueRange(bars);
    const spikeTr = clipped[20]!;
    expect(spikeTr).toBeGreaterThan(3); // still reads as elevated
  });

  it("does not clip anything before enough history has accumulated", () => {
    const bars = [bar(100), bar(1000), bar(100)]; // wild swings, but too little history to judge
    const clipped = trueRange(bars);
    expect(clipped[1]).toBeCloseTo(900, 6);
  });
});

describe("atr -- resistant to a single degenerate bar", () => {
  it("keeps the ATR reading close to its pre-corruption level a few bars after a single bad bar", () => {
    const bars = normalSeries(40);
    const normalAtr = atr(bars, 14).filter((v) => !Number.isNaN(v)).at(-1)!;

    const withGlitch = [...bars, bar(1), ...normalSeries(6, 100)];
    const glitchedAtr = atr(withGlitch, 14).filter((v) => !Number.isNaN(v)).at(-1)!;

    // Without clipping, this would be inflated by orders of magnitude
    // (the exact 2026-07-21 bug -- an ATR-derived stop distance in the
    // thousands of points against a ~100-point-scale instrument).
    expect(glitchedAtr).toBeLessThan(normalAtr * 10);
  });
});
