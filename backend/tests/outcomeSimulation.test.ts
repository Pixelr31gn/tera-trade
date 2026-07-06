import { describe, expect, it } from "vitest";
import { evaluateHypotheticalOutcome } from "../src/analytics/outcomeSimulation.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function bar(high: number, low: number, close: number): OhlcBar {
  return { time: new Date(), open: close, high, low, close, volume: 100 };
}

describe("evaluateHypotheticalOutcome", () => {
  it("labels a win when the target is hit before the stop, for a long setup", () => {
    const result = evaluateHypotheticalOutcome("long", 100, 98, 104, [bar(101, 99, 100.5), bar(105, 100, 104.5)]);
    expect(result.label).toBe("win");
    expect(result.rMultiple).toBeCloseTo(2); // (104-100)/(100-98) = 2
  });

  it("labels a loss when the stop is hit before the target, for a long setup", () => {
    const result = evaluateHypotheticalOutcome("long", 100, 98, 104, [bar(101, 99, 100.5), bar(100, 97, 97.5)]);
    expect(result.label).toBe("loss");
    expect(result.rMultiple).toBe(-1);
  });

  it("conservatively assumes the stop hit first when a single bar's range could have hit both", () => {
    const result = evaluateHypotheticalOutcome("long", 100, 98, 104, [bar(105, 97, 102)]);
    expect(result.label).toBe("loss");
  });

  it("labels a win for a short setup when the target (lower) is hit first", () => {
    const result = evaluateHypotheticalOutcome("short", 100, 102, 96, [bar(101, 98, 99), bar(99, 95, 95.5)]);
    expect(result.label).toBe("win");
    expect(result.rMultiple).toBeCloseTo(2); // (100-96)/(102-100) = 2
  });

  it("labels a loss for a short setup when the stop (higher) is hit first", () => {
    const result = evaluateHypotheticalOutcome("short", 100, 102, 96, [bar(103, 99, 102.5)]);
    expect(result.label).toBe("loss");
  });

  it("returns no_resolution when neither the stop nor the target is hit within the available bars", () => {
    const result = evaluateHypotheticalOutcome("long", 100, 98, 104, [bar(101, 99.5, 100.2), bar(100.5, 99.8, 100.1)]);
    expect(result.label).toBe("no_resolution");
  });

  it("returns no_resolution with rMultiple 0 when there are no bars at all", () => {
    const result = evaluateHypotheticalOutcome("long", 100, 98, 104, []);
    expect(result.label).toBe("no_resolution");
    expect(result.rMultiple).toBe(0);
  });
});
