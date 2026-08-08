import { describe, expect, it } from "vitest";
import { advanceExecutionState, checkOpportunityCost, computeAgePenalty } from "../src/execution/executionStateMachine.js";
import type { ExecutionOpportunity } from "../src/execution/executionStateMachine.js";
import type { EntryQualityScore } from "../src/execution/entryQualityModel.js";

function opportunity(overrides: Partial<ExecutionOpportunity> = {}): ExecutionOpportunity {
  return {
    symbol: "NQ",
    side: "long",
    strategyId: "test",
    signalScore: 0.85,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    state: "waiting",
    bestEntry: null,
    brokerOrderId: null,
    cancelReason: null,
    baseline: { entryScore: 90, stopDistance: 10, rewardDistance: 30, atrValue: 5, trendSlope: 0.01 },
    ...overrides,
  };
}

function score(value: number, price = 19990): EntryQualityScore {
  return { price, score: value, factors: [] };
}

describe("computeAgePenalty", () => {
  it("applies no penalty under 2 minutes", () => {
    expect(computeAgePenalty(60).penaltyPct).toBe(0);
    expect(computeAgePenalty(60).shouldCancel).toBe(false);
  });
  it("applies -2% between 2 and 4 minutes", () => {
    expect(computeAgePenalty(150).penaltyPct).toBe(0.02);
  });
  it("applies -5% between 4 and 6 minutes", () => {
    expect(computeAgePenalty(250).penaltyPct).toBe(0.05);
  });
  it("applies -8% between 6 and 8 minutes", () => {
    expect(computeAgePenalty(450).penaltyPct).toBe(0.08);
  });
  it("cancels at 8+ minutes", () => {
    const penalty = computeAgePenalty(481);
    expect(penalty.shouldCancel).toBe(true);
    expect(penalty.penaltyPct).toBe(1);
  });
});

describe("checkOpportunityCost", () => {
  const baseline = { entryScore: 90, stopDistance: 10, rewardDistance: 30, atrValue: 5, trendSlope: 0.01 };

  it("does not cancel when nothing has meaningfully changed", () => {
    const result = checkOpportunityCost({ baseline, currentEntryScore: 88, currentStopDistance: 10, currentRewardDistance: 30, currentAtrValue: 5, currentTrendSlope: 0.01 });
    expect(result.cancel).toBe(false);
  });

  it("cancels when entry score drops more than 30%", () => {
    const result = checkOpportunityCost({ baseline, currentEntryScore: 50, currentStopDistance: 10, currentRewardDistance: 30, currentAtrValue: 5, currentTrendSlope: 0.01 });
    expect(result.cancel).toBe(true);
    expect(result.reasons.join()).toContain("entry score dropped");
  });

  it("cancels when reward distance shrinks more than 30%", () => {
    const result = checkOpportunityCost({ baseline, currentEntryScore: 90, currentStopDistance: 10, currentRewardDistance: 15, currentAtrValue: 5, currentTrendSlope: 0.01 });
    expect(result.cancel).toBe(true);
    expect(result.reasons.join()).toContain("reward distance shrunk");
  });

  it("cancels when stop distance grows more than 30%", () => {
    const result = checkOpportunityCost({ baseline, currentEntryScore: 90, currentStopDistance: 15, currentRewardDistance: 30, currentAtrValue: 5, currentTrendSlope: 0.01 });
    expect(result.cancel).toBe(true);
    expect(result.reasons.join()).toContain("stop distance grew");
  });

  it("cancels when ATR expands more than 50%", () => {
    const result = checkOpportunityCost({ baseline, currentEntryScore: 90, currentStopDistance: 10, currentRewardDistance: 30, currentAtrValue: 8, currentTrendSlope: 0.01 });
    expect(result.cancel).toBe(true);
    expect(result.reasons.join()).toContain("ATR expanded");
  });
});

describe("advanceExecutionState", () => {
  it("moves to ready when the best candidate clears threshold with no penalty", () => {
    const result = advanceExecutionState({
      opportunity: opportunity(),
      scores: [score(95)],
      minThreshold: 85,
      now: new Date("2026-01-01T00:00:30Z"), // 30s old
      currentStopDistance: 10,
      currentRewardDistance: 30,
      currentAtrValue: 5,
      currentTrendSlope: 0.01,
    });
    expect(result.opportunity.state).toBe("ready");
  });

  it("stays in building_entry when nothing clears threshold", () => {
    // 70 is below the 85 threshold but still within 30% of the baseline (90)
    // -- isolates "didn't clear the bar" from opportunity-cost cancellation.
    const result = advanceExecutionState({
      opportunity: opportunity(),
      scores: [score(70)],
      minThreshold: 85,
      now: new Date("2026-01-01T00:00:30Z"),
      currentStopDistance: 10,
      currentRewardDistance: 30,
      currentAtrValue: 5,
      currentTrendSlope: 0.01,
    });
    expect(result.opportunity.state).toBe("building_entry");
  });

  it("cancels once the setup exceeds max age regardless of score", () => {
    const result = advanceExecutionState({
      opportunity: opportunity(),
      scores: [score(99)],
      minThreshold: 85,
      now: new Date("2026-01-01T00:08:01Z"), // just past 8 min
      currentStopDistance: 10,
      currentRewardDistance: 30,
      currentAtrValue: 5,
      currentTrendSlope: 0.01,
    });
    expect(result.opportunity.state).toBe("cancelled");
    expect(result.opportunity.cancelReason).toContain("max age");
  });

  it("cancels on opportunity-cost degradation even when age is fine", () => {
    const result = advanceExecutionState({
      opportunity: opportunity(),
      scores: [score(95)],
      minThreshold: 85,
      now: new Date("2026-01-01T00:01:00Z"),
      currentStopDistance: 20, // grew well past the 30% threshold
      currentRewardDistance: 30,
      currentAtrValue: 5,
      currentTrendSlope: 0.01,
    });
    expect(result.opportunity.state).toBe("cancelled");
    expect(result.opportunity.cancelReason).toContain("stop distance grew");
  });

  it("leaves resting_order/filled/cancelled states untouched -- terminal or broker-driven", () => {
    for (const state of ["resting_order", "filled", "cancelled"] as const) {
      const result = advanceExecutionState({
        opportunity: opportunity({ state }),
        scores: [score(99)],
        minThreshold: 85,
        now: new Date("2026-01-01T00:20:00Z"), // well past cancellation age
        currentStopDistance: 10,
        currentRewardDistance: 30,
        currentAtrValue: 5,
        currentTrendSlope: 0.01,
      });
      expect(result.opportunity.state).toBe(state);
    }
  });

  it("applies the age penalty before comparing to threshold, not just for display", () => {
    // Score of 87 clears 85 raw, but a -5% penalty at 4-6 min brings it to
    // 82.65, which should NOT be ready yet.
    const result = advanceExecutionState({
      opportunity: opportunity(),
      scores: [score(87)],
      minThreshold: 85,
      now: new Date("2026-01-01T00:05:00Z"),
      currentStopDistance: 10,
      currentRewardDistance: 30,
      currentAtrValue: 5,
      currentTrendSlope: 0.01,
    });
    expect(result.opportunity.state).toBe("building_entry");
  });
});
