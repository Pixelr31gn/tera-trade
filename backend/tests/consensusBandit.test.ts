import { describe, expect, it } from "vitest";
import { computeUcbScore, selectBanditVersion, CONSENSUS_BANDIT_ARMS, type BucketVersionStats } from "../src/scoring/consensusBandit.js";
import type { StrategyVersion } from "../src/scoring/ruleScorer.js";

function stats(version: StrategyVersion, plays: number, meanRMultiple: number): BucketVersionStats {
  return { version, plays, meanRMultiple };
}

describe("computeUcbScore", () => {
  it("returns Infinity for an untried arm (optimistic initialization)", () => {
    expect(computeUcbScore(stats("v1", 0, 0), 50, 0.5)).toBe(Infinity);
  });

  it("a higher mean reward scores higher, holding plays and totalBucketPlays fixed", () => {
    const low = computeUcbScore(stats("v1", 10, 0.1), 100, 0.5);
    const high = computeUcbScore(stats("v1", 10, 0.3), 100, 0.5);
    expect(high).toBeGreaterThan(low);
  });

  it("the exploration bonus shrinks as an arm accumulates more plays, holding mean and totalBucketPlays fixed", () => {
    const fewPlays = computeUcbScore(stats("v1", 5, 0.1), 100, 0.5);
    const manyPlays = computeUcbScore(stats("v1", 50, 0.1), 100, 0.5);
    expect(fewPlays).toBeGreaterThan(manyPlays);
  });

  it("a larger exploration constant increases the score for an already-played arm", () => {
    const narrow = computeUcbScore(stats("v1", 10, 0.1), 100, 0.1);
    const wide = computeUcbScore(stats("v1", 10, 0.1), 100, 2.0);
    expect(wide).toBeGreaterThan(narrow);
  });
});

describe("selectBanditVersion", () => {
  it("is cold-start when total plays across all arms is below minBucketSamples, even if individual arms look fine", () => {
    const result = selectBanditVersion(
      new Map([
        ["v1", stats("v1", 5, 0.3)],
        ["v2", stats("v2", 5, 0.1)],
      ]),
      "bucket-a",
      0.5,
      /* minBucketSamples */ 20,
      /* minPerArmSamples */ 3
    );
    expect(result.coldStart).toBe(true);
    expect(result.armScores.size).toBe(0);
  });

  it("is cold-start when total plays clears minBucketSamples but one arm individually has too few plays", () => {
    const result = selectBanditVersion(
      new Map([
        ["v1", stats("v1", 18, 0.3)],
        ["v2", stats("v2", 2, 0.1)], // below minPerArmSamples=3
      ]),
      "bucket-a",
      0.5,
      20,
      3
    );
    expect(result.coldStart).toBe(true);
  });

  it("cold-start selectedVersion always falls back to the first configured arm, regardless of which arm's stats were passed", () => {
    const result = selectBanditVersion(new Map([["v3", stats("v3", 1, 0.9)]]), "bucket-a", 0.5, 20, 3);
    expect(result.coldStart).toBe(true);
    expect(result.selectedVersion).toBe(CONSENSUS_BANDIT_ARMS[0]);
  });

  it("selects the higher-mean arm when both arms have identical play counts (no exploration-bonus tiebreak needed)", () => {
    const result = selectBanditVersion(
      new Map([
        ["v1", stats("v1", 10, 0.3)],
        ["v2", stats("v2", 10, 0.1)],
      ]),
      "bucket-a",
      0.5,
      20,
      3
    );
    expect(result.coldStart).toBe(false);
    expect(result.selectedVersion).toBe("v1");
    expect(result.armScores.size).toBe(2);
  });

  it("selects a lower-mean but much-less-played arm over a higher-mean, heavily-played arm when its exploration bonus outweighs the mean gap -- the actual UCB tradeoff, not just 'pick the best average'", () => {
    // A: mean 0.20 over 15 plays. B: mean 0.05 over 5 plays. total=20 (clears
    // minBucketSamples=20), both >= minPerArmSamples=3.
    // scoreA = 0.20 + 0.5*sqrt(ln(20)/15) ~= 0.4234
    // scoreB = 0.05 + 0.5*sqrt(ln(20)/5)  ~= 0.4370  <- wins despite lower mean
    const result = selectBanditVersion(
      new Map([
        ["v1", stats("v1", 15, 0.2)],
        ["v2", stats("v2", 5, 0.05)],
      ]),
      "bucket-a",
      0.5,
      20,
      3
    );
    expect(result.coldStart).toBe(false);
    expect(result.selectedVersion).toBe("v2");
    expect(result.armScores.get("v2")!).toBeGreaterThan(result.armScores.get("v1")!);
  });

  it("carries the bucket key through to the result unchanged", () => {
    const result = selectBanditVersion(new Map([["v1", stats("v1", 30, 0.2)]]), "new_york:up:normal", 0.5, 20, 3);
    expect(result.bucket).toBe("new_york:up:normal");
  });
});
