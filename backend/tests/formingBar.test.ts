import { Decimal } from "decimal.js";
import { afterEach, describe, expect, it } from "vitest";
import { setFormingBarSource, withFormingBar } from "../src/engine/formingBar.js";
import { MinuteBarAggregator } from "../src/marketData/minuteBarAggregator.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const T = Date.parse("2026-10-12T23:00:00Z");
const bar = (min: number, close: number): OhlcBar => ({ time: new Date(T + min * 60_000), open: close, high: close, low: close, close, volume: 1 });

afterEach(() => setFormingBarSource(null));

describe("withFormingBar", () => {
  it("returns the bars unchanged when no source is registered", () => {
    const bars = [bar(0, 100), bar(1, 101)];
    expect(withFormingBar("NQ", bars)).toBe(bars);
  });

  it("appends the forming minute from the aggregator, updating as ticks arrive within it", () => {
    const agg = new MinuteBarAggregator();
    setFormingBarSource((s) => agg.getFormingBar(s));
    const completed = [bar(0, 100), bar(1, 101)];
    agg.addTick("NQ", new Decimal(101.5), new Decimal(1), new Date(T + 2 * 60_000 + 5_000));
    expect(withFormingBar("NQ", completed).at(-1)).toMatchObject({ close: 101.5, time: new Date(T + 2 * 60_000) });
    agg.addTick("NQ", new Decimal(102.25), new Decimal(1), new Date(T + 2 * 60_000 + 20_000));
    const out = withFormingBar("NQ", completed);
    expect(out).toHaveLength(3);
    expect(out.at(-1)).toMatchObject({ close: 102.25, high: 102.25, low: 101.5 });
  });

  it("doesn't append a forming bar that isn't newer than the last completed bar", () => {
    const agg = new MinuteBarAggregator();
    setFormingBarSource((s) => agg.getFormingBar(s));
    agg.addTick("NQ", new Decimal(101), new Decimal(1), new Date(T + 1 * 60_000 + 5_000));
    expect(withFormingBar("NQ", [bar(0, 100), bar(1, 101)])).toHaveLength(2);
  });
});
