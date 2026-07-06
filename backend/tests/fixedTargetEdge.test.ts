import { describe, expect, it } from "vitest";
import { summarizeFixedTargetOutcomes } from "../src/analytics/fixedTargetEdge.js";

describe("summarizeFixedTargetOutcomes", () => {
  it("computes win rate over resolved (win/loss) samples only, excluding no_resolution", () => {
    const stats = summarizeFixedTargetOutcomes(["win", "win", "loss", "no_resolution"]);
    expect(stats.sampleSize).toBe(3);
    expect(stats.winRate).toBeCloseTo(2 / 3);
  });

  it("returns a null win rate when there are no resolved samples", () => {
    const stats = summarizeFixedTargetOutcomes(["no_resolution", "no_resolution"]);
    expect(stats.sampleSize).toBe(0);
    expect(stats.winRate).toBeNull();
  });

  it("returns a null win rate for an empty list", () => {
    const stats = summarizeFixedTargetOutcomes([]);
    expect(stats.sampleSize).toBe(0);
    expect(stats.winRate).toBeNull();
  });

  it("computes a 0% win rate when every resolved sample lost", () => {
    const stats = summarizeFixedTargetOutcomes(["loss", "loss", "loss"]);
    expect(stats.sampleSize).toBe(3);
    expect(stats.winRate).toBe(0);
  });
});
