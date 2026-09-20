import { describe, expect, it } from "vitest";
import { findUnderperformers } from "../src/crossRegimeAnalyzer/analyze.js";

function makeBreakdown(entries: Record<string, { sampleSize: number; avgRMultiple: number | null }>) {
  const out: Record<string, { sampleSize: number; resolvedCount: number; winRate: number | null; avgRMultiple: number | null }> = {};
  for (const [label, v] of Object.entries(entries)) {
    out[label] = { sampleSize: v.sampleSize, resolvedCount: v.sampleSize, winRate: 0.5, avgRMultiple: v.avgRMultiple };
  }
  return out;
}

// Minimal shape matching computeSessionPerformanceForAllSessions's return type -- only the three
// breakdown fields findUnderperformers actually reads.
function makeSessionPerformance(perSession: Record<string, { byMarketStructure?: object; byLiquidity?: object; byPriceAction?: object }>) {
  const result: Record<string, unknown> = {};
  for (const [session, breakdowns] of Object.entries(perSession)) {
    result[session] = {
      byMarketStructure: breakdowns.byMarketStructure ?? {},
      byLiquidity: breakdowns.byLiquidity ?? {},
      byPriceAction: breakdowns.byPriceAction ?? {},
    };
  }
  return result as unknown as Parameters<typeof findUnderperformers>[0];
}

describe("crossRegimeAnalyzer.findUnderperformers", () => {
  it("flags a label below the sample-size floor and the avgR floor", () => {
    const perf = makeSessionPerformance({
      london: { byPriceAction: makeBreakdown({ upper_wick_rejection: { sampleSize: 100, avgRMultiple: -0.15 } }) },
    });
    const flagged = findUnderperformers(perf, { minSampleSize: 20, maxAvgR: -0.03 });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ session: "london", dimension: "priceAction", label: "upper_wick_rejection", sampleSize: 100, avgRMultiple: -0.15 });
  });

  it("does not flag a small sample even with a bad avgR", () => {
    const perf = makeSessionPerformance({
      london: { byPriceAction: makeBreakdown({ rare_pattern: { sampleSize: 3, avgRMultiple: -0.5 } }) },
    });
    expect(findUnderperformers(perf, { minSampleSize: 20, maxAvgR: -0.03 })).toHaveLength(0);
  });

  it("does not flag a large sample with a positive or near-zero avgR", () => {
    const perf = makeSessionPerformance({
      new_york: { byMarketStructure: makeBreakdown({ strong_uptrend: { sampleSize: 500, avgRMultiple: 0.02 } }) },
    });
    expect(findUnderperformers(perf, { minSampleSize: 20, maxAvgR: -0.03 })).toHaveLength(0);
  });

  it("skips labels with no resolved R data yet (avgRMultiple null)", () => {
    const perf = makeSessionPerformance({
      asian: { byLiquidity: makeBreakdown({ liquidity_sweep: { sampleSize: 50, avgRMultiple: null } }) },
    });
    expect(findUnderperformers(perf, { minSampleSize: 20, maxAvgR: -0.03 })).toHaveLength(0);
  });

  it("sorts worst avgR first across sessions and dimensions", () => {
    const perf = makeSessionPerformance({
      london: { byPriceAction: makeBreakdown({ mild_loser: { sampleSize: 50, avgRMultiple: -0.05 } }) },
      new_york: { byMarketStructure: makeBreakdown({ bad_loser: { sampleSize: 50, avgRMultiple: -0.2 } }) },
    });
    const flagged = findUnderperformers(perf, { minSampleSize: 20, maxAvgR: -0.03 });
    expect(flagged.map((f) => f.label)).toEqual(["bad_loser", "mild_loser"]);
  });
});
