import { describe, expect, it } from "vitest";
import { BreakoutStrategy } from "../src/strategy/breakout.js";
import { MeanReversionStrategy } from "../src/strategy/meanReversion.js";
import { TrendFollowingStrategy } from "../src/strategy/trendFollowing.js";
import { TrendPullbackFibStrategy, computeExplicitStopTarget } from "../src/strategy/trendPullbackFib.js";
import type { TrendLeg } from "../src/strategy/trendPullbackFib.js";
import { makeRangingBars, makeTrendingBars } from "./fixtures.js";
import type { OhlcBar } from "../src/regime/indicators.js";

describe("BreakoutStrategy", () => {
  it("fires long on a new high somewhere in a strong uptrend", () => {
    const bars = makeTrendingBars();
    const strategy = new BreakoutStrategy();
    let found = null;
    for (let i = 21; i < bars.length; i++) {
      const signal = strategy.generateSignal("ES", bars.slice(0, i + 1));
      if (signal) {
        found = signal;
        break;
      }
    }
    expect(found).not.toBeNull();
    expect(found?.side).toBe("long");
  });
});

describe("MeanReversionStrategy", () => {
  it("fires on a Bollinger Band extreme in a ranging market", () => {
    const bars = makeRangingBars();
    const strategy = new MeanReversionStrategy();
    let found = null;
    for (let i = 30; i < bars.length; i++) {
      const signal = strategy.generateSignal("ES", bars.slice(0, i + 1));
      if (signal) {
        found = signal;
        break;
      }
    }
    expect(found).not.toBeNull();
    expect(["long", "short"]).toContain(found?.side);
  });
});

describe("TrendFollowingStrategy", () => {
  it("detects an EMA crossover in an uptrend", () => {
    const bars = makeTrendingBars();
    const strategy = new TrendFollowingStrategy();
    let fired = false;
    for (let i = 22; i < bars.length; i++) {
      const signal = strategy.generateSignal("ES", bars.slice(0, i + 1));
      if (signal) {
        expect(signal.side).toBe("long");
        fired = true;
        break;
      }
    }
    expect(fired).toBe(true);
  });
});

describe("TrendPullbackFibStrategy", () => {
  // Hand-built 15m OHLC targets, each expanded into 15 one-minute bars whose
  // aggregate reproduces the exact target (see splitInto1mBars) -- a random
  // walk fixture can't reliably produce this specific a shape (rising 20 EMA,
  // a clean rally, then a 3+ bar lower-high/lower-low pullback landing
  // exactly in the 40-60% fib zone), so this is constructed like
  // riskEngine.test.ts's barsWithPivotHighNear rather than sampled. 15
  // sub-bars, not 3 -- aggregateTo15m now requires 13+ of 15 real 1-minute
  // sub-bars per bucket to call it closed (see that function's own comment;
  // the live feed has been genuine 1-minute bars since MinuteBarAggregator,
  // not the 5-minute stream this fixture originally assumed).
  function splitInto1mBars(time: Date, open: number, high: number, low: number, close: number): OhlcBar[] {
    const COUNT = 15;
    const bars: OhlcBar[] = [];
    for (let i = 0; i < COUNT; i++) {
      const prevClose = i === 0 ? open : bars[i - 1]!.close;
      const c = open + (close - open) * (i / (COUNT - 1));
      const barHigh = i === 1 ? high : Math.max(c, prevClose);
      const barLow = i === 2 ? low : Math.min(c, prevClose);
      bars.push({ time: new Date(time.getTime() + i * 60_000), open: prevClose, high: barHigh, low: barLow, close: c, volume: 10 });
    }
    return bars;
  }

  function buildFixture(): OhlcBar[] {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    const bars15m: { open: number; high: number; low: number; close: number }[] = [];

    // Rally: 22 clean green 15m bars, price climbing 100 -> 166.
    for (let i = 0; i < 22; i++) {
      const open = 100 + 3 * i;
      const close = open + 3;
      bars15m.push({ open, high: close + 0.5, low: open - 0.5, close });
    }
    // Correction: 4 red 15m bars, strictly lower highs/lows, retracing to ~134.5
    // (the rally ran 102.5 -> 166.5, so 134.5 sits at the ~50% fib level).
    bars15m.push({ open: 165, high: 165.5, low: 155, close: 155.5 });
    bars15m.push({ open: 155, high: 156, low: 145, close: 145.5 });
    bars15m.push({ open: 145, high: 146, low: 137, close: 137.5 });
    bars15m.push({ open: 137, high: 138, low: 134, close: 134.5 });

    const bars5m: OhlcBar[] = [];
    bars15m.forEach((b, i) => {
      bars5m.push(...splitInto1mBars(new Date(start + i * 15 * 60_000), b.open, b.high, b.low, b.close));
    });

    // One more 5m bar, in a still-forming (incomplete) 15m bucket, breaking
    // above the correction leg's last red 15m bar's high (138) -- the entry
    // trigger. High-only break, no close requirement, per the spec.
    const triggerTime = new Date(start + bars15m.length * 15 * 60_000);
    bars5m.push({ time: triggerTime, open: 135, high: 139, low: 134.5, close: 138.5, volume: 100 });

    return bars5m;
  }

  it("fires long on a 40-60% fib pullback into a rising 15m trend, breaking the correction leg's last red bar", () => {
    const bars = buildFixture();
    const strategy = new TrendPullbackFibStrategy();
    const signal = strategy.generateSignal("ES", bars);
    expect(signal).not.toBeNull();
    expect(signal?.side).toBe("long");
    expect(signal?.signalKind).toBe("reversal");
    // This fixture's own sharp rally-then-correction leaves the genuine 5m
    // 20 EMA (a real 100-minute lookback, see trendPullbackFib.ts's
    // 2026-08-03 aggregateTo5m fix) still above the trigger price -- it
    // hasn't caught up to such a fast, large move yet -- so
    // computeExplicitStopTarget's own guard correctly declines to set an
    // explicit override here rather than hand back a backwards stop; the
    // signal falls back to the generic structure/ATR stop like every other
    // strategy. See computeExplicitStopTarget's own tests for fixtures
    // where the override DOES apply.
    expect(signal?.explicitStopPrice).toBeUndefined();
    expect(signal?.explicitTakeProfitPrice).toBeUndefined();
  });

  it("does not fire before the 5m break above the correction leg's high", () => {
    const bars = buildFixture();
    const strategy = new TrendPullbackFibStrategy();
    // Drop the trigger bar -- still sitting in the fib zone, but no break yet.
    const signal = strategy.generateSignal("ES", bars.slice(0, -1));
    expect(signal).toBeNull();
  });

  // Short-side mirror of buildFixture above (2026-08-02, operator request --
  // the buy setup generalizes symmetrically to a sell setup: falling 15m EMA
  // + a bounce-up correction retracing 40-60% of the preceding decline,
  // entering short on a 5m break below the bounce's last green bar). Every
  // price here is buildFixture's reflected through 266 (the sum of that
  // fixture's trend peak 166.5 and trough 99.5), so this exercises the exact
  // mirror-image structure of the already-verified long fixture rather than
  // an independently hand-picked one.
  function buildShortFixture(): OhlcBar[] {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    const bars15m: { open: number; high: number; low: number; close: number }[] = [];

    // Decline: 22 clean red 15m bars, price falling 166 -> 100.
    for (let i = 0; i < 22; i++) {
      const open = 166 - 3 * i;
      const close = open - 3;
      bars15m.push({ open, high: open + 0.5, low: close - 0.5, close });
    }
    // Correction: 4 green 15m bars, strictly higher highs/lows, bouncing to ~131.5
    // (the decline ran 166.5 -> 99.5, so 131.5 sits at the ~48% fib level).
    bars15m.push({ open: 101, high: 111, low: 100.5, close: 110.5 });
    bars15m.push({ open: 111, high: 121, low: 110, close: 120.5 });
    bars15m.push({ open: 121, high: 129, low: 120, close: 128.5 });
    bars15m.push({ open: 129, high: 132, low: 128, close: 131.5 });

    const bars5m: OhlcBar[] = [];
    bars15m.forEach((b, i) => {
      bars5m.push(...splitInto1mBars(new Date(start + i * 15 * 60_000), b.open, b.high, b.low, b.close));
    });

    // One more 5m bar, in a still-forming 15m bucket, breaking below the
    // correction leg's last green 15m bar's low (128) -- the entry trigger.
    const triggerTime = new Date(start + bars15m.length * 15 * 60_000);
    bars5m.push({ time: triggerTime, open: 131, high: 131.5, low: 127, close: 127.5, volume: 100 });

    return bars5m;
  }

  it("fires short on a 40-60% fib bounce into a falling 15m trend, breaking the correction leg's last green bar", () => {
    const bars = buildShortFixture();
    const strategy = new TrendPullbackFibStrategy();
    const signal = strategy.generateSignal("ES", bars);
    expect(signal).not.toBeNull();
    expect(signal?.side).toBe("short");
    expect(signal?.signalKind).toBe("reversal");
  });

  it("does not fire before the 5m break below the correction leg's low (short side)", () => {
    const bars = buildShortFixture();
    const strategy = new TrendPullbackFibStrategy();
    const signal = strategy.generateSignal("ES", bars.slice(0, -1));
    expect(signal).toBeNull();
  });

  // Regression fixture for the 2026-08-02 fix: findPrecedingRallyLeg used to
  // search a fixed 20-bar window for the single lowest low, so a short,
  // clean rally sitting behind an unrelated deep crash (still within that
  // 20-bar window) got its swing low dragged into the crash -- the "leg"
  // then spanned the crash's red bars too, failing the <= 1 red bar quality
  // check and producing no signal at all, even though the actual recent
  // rally was clean. The fix walks backward from the peak and stops the leg
  // at the first real break in structure instead of an arbitrary bar count.
  function buildShortRallyBehindUnrelatedCrashFixture(): OhlcBar[] {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    const bars15m: { open: number; high: number; low: number; close: number }[] = [];

    // Padding so bars15m.length clears EMA_PERIOD + EMA_SLOPE_LOOKBACK_BARS
    // -- far above everything that follows, irrelevant to the rally search.
    for (let i = 0; i < 10; i++) {
      const open = 260 + i;
      const close = open + 1;
      bars15m.push({ open, high: close + 0.3, low: open - 0.3, close });
    }
    // Deep, unrelated crash (3 red bars) -- old algorithm's fixed-window
    // lowest-low search latches onto this even though it has nothing to do
    // with the rally that actually leads into the correction below.
    bars15m.push({ open: 250, high: 250.5, low: 219.5, close: 220 });
    bars15m.push({ open: 220, high: 220.5, low: 184.5, close: 185 });
    bars15m.push({ open: 185, high: 185.5, low: 149.5, close: 150 });
    // Choppy consolidation (mixed colors) between the crash and the real rally.
    bars15m.push({ open: 150, high: 161, low: 149, close: 160 });
    bars15m.push({ open: 160, high: 161, low: 154, close: 155 });
    bars15m.push({ open: 155, high: 164, low: 154, close: 163 });
    bars15m.push({ open: 163, high: 164, low: 157, close: 158 });
    bars15m.push({ open: 158, high: 166, low: 157, close: 165 });
    // The actual, clean rally leg (9 green bars, no fixed length required).
    let o = 165;
    for (let i = 0; i < 9; i++) {
      const close = o + 7;
      bars15m.push({ open: o, high: close + 0.5, low: o - 0.5, close });
      o = close;
    }
    const peak = bars15m.at(-1)!.close;

    // Correction: 3 red bars, strictly lower highs/lows, retracing to ~50%
    // of the actual (short) rally leg -- not the crash's much larger range.
    const rallyStart = 165;
    const target50 = peak - (peak - rallyStart) * 0.5;
    const step = (peak - 1 - target50) / 3;
    let c = peak - 1;
    for (let i = 0; i < 3; i++) {
      const close = c - step;
      bars15m.push({ open: c, high: c + 0.5, low: close - 0.5, close });
      c = close;
    }
    const triggerLevel = bars15m.at(-1)!.high;

    const bars5m: OhlcBar[] = [];
    bars15m.forEach((b, i) => {
      bars5m.push(...splitInto1mBars(new Date(start + i * 15 * 60_000), b.open, b.high, b.low, b.close));
    });

    const triggerTime = new Date(start + bars15m.length * 15 * 60_000);
    bars5m.push({ time: triggerTime, open: c, high: triggerLevel + 1, low: c - 1, close: triggerLevel + 0.5, volume: 100 });

    return bars5m;
  }

  it("fires on a short, clean rally even when a much deeper, unrelated crash sits earlier in the same lookback window", () => {
    const bars = buildShortRallyBehindUnrelatedCrashFixture();
    const strategy = new TrendPullbackFibStrategy();
    const signal = strategy.generateSignal("ES", bars);
    expect(signal).not.toBeNull();
    expect(signal?.side).toBe("long");
  });

  // computeExplicitStopTarget (2026-08-03, operator spec): stop always at
  // the 5m 20 EMA, target at the trend leg's own peak/trough, clamped to a
  // 2:1-4:1 reward:risk band. Numerically verified fixture: 19 closed 5m
  // buckets flat at close=100, then a final closed 5m bucket at close=105 --
  // gives ema20 ~= 100.476 (alpha=2/21, a single step from a converged-flat
  // EMA), so stopDistance = |105 - 100.476| ~= 4.524, meaning the 2x/4x band
  // is ~9.05 to ~18.10 points from entry. Built from 1-minute sub-bars (5 per
  // bucket), not literal 5-minute-spaced bars -- computeExplicitStopTarget
  // now aggregates via aggregateTo5m internally (2026-08-03, see
  // trendPullbackFib.ts's header), so a bar every 5 minutes would each land
  // in its own separate, incomplete bucket and get dropped entirely. The
  // aggregate close sequence, and therefore every expected value below, is
  // unchanged from before that fix.
  describe("computeExplicitStopTarget", () => {
    function buildEmaFixture(finalClose: number): OhlcBar[] {
      const start = new Date("2026-01-01T00:00:00Z").getTime();
      const bars: OhlcBar[] = [];
      for (let bucket = 0; bucket < 19; bucket++) {
        for (let i = 0; i < 5; i++) {
          bars.push({ time: new Date(start + (bucket * 5 + i) * 60_000), open: 100, high: 100, low: 100, close: 100, volume: 10 });
        }
      }
      for (let i = 0; i < 5; i++) {
        bars.push({ time: new Date(start + (19 * 5 + i) * 60_000), open: finalClose, high: finalClose, low: finalClose, close: finalClose, volume: 10 });
      }
      return bars;
    }

    const EMA20 = 100.47619047619048;
    const ENTRY = 105;
    const STOP_DISTANCE = ENTRY - EMA20; // ~4.524

    it("uses the natural trend-leg target as-is when it falls within the 2x-4x band", () => {
      const bars = buildEmaFixture(ENTRY);
      const trendLeg: TrendLeg = { farIndex: 0, nearIndex: 0, farPrice: 90, nearPrice: ENTRY + 12 }; // 12pt natural target, band is ~9.05-18.10
      const result = computeExplicitStopTarget(bars, trendLeg, "up");
      expect(result).not.toBeNull();
      expect(result!.stopPrice).toBeCloseTo(EMA20, 5);
      expect(result!.takeProfitPrice).toBeCloseTo(ENTRY + 12, 5);
    });

    it("extends the target to exactly 2x the stop distance when the natural target is closer than that", () => {
      const bars = buildEmaFixture(ENTRY);
      const trendLeg: TrendLeg = { farIndex: 0, nearIndex: 0, farPrice: 90, nearPrice: ENTRY + 5 }; // 5pt natural target, below the ~9.05 floor
      const result = computeExplicitStopTarget(bars, trendLeg, "up");
      expect(result).not.toBeNull();
      expect(result!.takeProfitPrice).toBeCloseTo(ENTRY + STOP_DISTANCE * 2, 5);
    });

    it("caps the target at exactly 4x the stop distance when the natural target is farther than that", () => {
      const bars = buildEmaFixture(ENTRY);
      const trendLeg: TrendLeg = { farIndex: 0, nearIndex: 0, farPrice: 90, nearPrice: ENTRY + 25 }; // 25pt natural target, above the ~18.10 ceiling
      const result = computeExplicitStopTarget(bars, trendLeg, "up");
      expect(result).not.toBeNull();
      expect(result!.takeProfitPrice).toBeCloseTo(ENTRY + STOP_DISTANCE * 4, 5);
    });

    it("returns null when the EMA sits on the wrong side of price for a long (hasn't caught up to a fast move)", () => {
      const bars = buildEmaFixture(95); // ema ends up ABOVE 95, invalid stop for a long
      const trendLeg: TrendLeg = { farIndex: 0, nearIndex: 0, farPrice: 80, nearPrice: 110 };
      const result = computeExplicitStopTarget(bars, trendLeg, "up");
      expect(result).toBeNull();
    });

    it("mirrors for shorts -- returns null when the EMA sits below price instead of above", () => {
      const bars = buildEmaFixture(105); // ema ends up BELOW 105, invalid stop for a short
      const trendLeg: TrendLeg = { farIndex: 0, nearIndex: 0, farPrice: 120, nearPrice: 90 };
      const result = computeExplicitStopTarget(bars, trendLeg, "down");
      expect(result).toBeNull();
    });

    it("mirrors for shorts -- valid stop above price, target below, same clamping band", () => {
      const bars = buildEmaFixture(95); // ema ~99.52, above entry 95 -- valid stop for a short
      const emaVal = 100 - (2 / 21) * 5; // same math, mirrored: 100 + alpha*(95-100)
      const stopDist = Math.abs(emaVal - 95);
      const trendLeg: TrendLeg = { farIndex: 0, nearIndex: 0, farPrice: 110, nearPrice: 95 - stopDist * 3 }; // within the 2x-4x band
      const result = computeExplicitStopTarget(bars, trendLeg, "down");
      expect(result).not.toBeNull();
      expect(result!.stopPrice).toBeCloseTo(emaVal, 5);
      expect(result!.takeProfitPrice).toBeCloseTo(95 - stopDist * 3, 5);
    });

    it("returns null when there aren't enough 5m bars for a 20 EMA reading", () => {
      const bars = buildEmaFixture(ENTRY).slice(0, 10);
      const trendLeg: TrendLeg = { farIndex: 0, nearIndex: 0, farPrice: 90, nearPrice: 117 };
      const result = computeExplicitStopTarget(bars, trendLeg, "up");
      expect(result).toBeNull();
    });
  });
});
