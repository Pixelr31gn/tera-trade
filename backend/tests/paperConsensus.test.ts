import { describe, expect, it } from "vitest";
import { determineConsensus, determineContinuousScanConsensus } from "../src/engine/loop.js";
import type { GatedScore } from "../src/scoring/gate.js";
import type { StrategyVersion } from "../src/scoring/ruleScorer.js";

function gated(decision: "taken" | "skipped_score", probability: number): GatedScore {
  return { probability, decision, factors: [], modelUsed: "rule_v1", blockReason: null, v3Bucket: null };
}

function map(v1: GatedScore, v2: GatedScore, v3: GatedScore): Map<StrategyVersion, GatedScore> {
  return new Map([
    ["v1", v1],
    ["v2", v2],
    ["v3", v3],
  ]);
}

// Threshold is 65% (core/config.ts's MIN_SCORE_THRESHOLD, backend/.env confirms 0.65 in this environment).
describe("determineConsensus -- majority-vote rule (2026-07-16 operator request)", () => {
  it("takes when exactly 2 of 3 versions clear 65%, even with the third strongly disagreeing", () => {
    const result = determineConsensus(map(gated("taken", 0.72), gated("skipped_score", 0.35), gated("taken", 0.65)));
    expect(result.taken).toBe(true);
  });

  it("takes when all 3 versions clear 65% (unanimous is still a majority)", () => {
    const result = determineConsensus(map(gated("taken", 0.7), gated("taken", 0.68), gated("taken", 0.75)));
    expect(result.taken).toBe(true);
  });

  it("does not take when only 1 of 3 clears 65%, no matter how high its score is", () => {
    const v1Alone = determineConsensus(map(gated("taken", 0.99), gated("skipped_score", 0.3), gated("skipped_score", 0.3)));
    expect(v1Alone.taken).toBe(false);
    const v3Alone = determineConsensus(map(gated("skipped_score", 0.3), gated("skipped_score", 0.3), gated("taken", 0.99)));
    expect(v3Alone.taken).toBe(false);
  });

  it("does not take when no version clears 65%", () => {
    const result = determineConsensus(map(gated("skipped_score", 0.4), gated("skipped_score", 0.3), gated("skipped_score", 0.35)));
    expect(result.taken).toBe(false);
    expect(result.representativeVersion).toBeNull();
  });

  it("counts a version toward the majority by raw probability, even if its own decision is skipped (v3's extra directional-conviction gate)", () => {
    // v3 scores 70% (clears 65%) but its own decision is skipped_score (e.g.
    // blocked by the directional-conviction margin check in gate.ts) -- it
    // still counts toward the 2-of-3 majority here since v1 also clears.
    const result = determineConsensus(map(gated("taken", 0.66), gated("skipped_score", 0.3), gated("skipped_score", 0.7)));
    expect(result.taken).toBe(true);
    // representativeVersion must fall back to v1 -- v3 isn't in takenVersions
    // (its own decision is skipped_score) even though it counted toward taken.
    expect(result.representativeVersion).toBe("v1");
  });

  it("prefers v3 as the representative version when it agrees, falling back to v2 then v1", () => {
    const allTaken = determineConsensus(map(gated("taken", 0.7), gated("taken", 0.7), gated("taken", 0.7)));
    expect(allTaken.representativeVersion).toBe("v3");

    const noV3 = determineConsensus(map(gated("taken", 0.7), gated("taken", 0.7), gated("skipped_score", 0.4)));
    expect(noV3.taken).toBe(true);
    expect(noV3.representativeVersion).toBe("v2");
  });

  it("includes a readable per-version summary with the clearing count and average", () => {
    const result = determineConsensus(map(gated("taken", 0.71), gated("taken", 0.65), gated("skipped_score", 0.4)));
    expect(result.summary).toContain("2/3 versions");
    expect(result.summary).toContain("avg=");
    expect(result.summary).toContain("v1=clears");
    expect(result.summary).toContain("v2=clears");
    expect(result.summary).toContain("v3=below");
  });
});

// Standout >=70%, floor >=50% for the other two -- 2026-07-16 operator
// request, made continuous-scan trades executable for the first time.
describe("determineContinuousScanConsensus -- standout+floor rule (2026-07-16 operator request)", () => {
  it("takes when one version clears 70% and the other two are each at least 50%", () => {
    const result = determineContinuousScanConsensus(map(gated("taken", 0.77), gated("skipped_score", 0.55), gated("skipped_score", 0.5)));
    expect(result.taken).toBe(true);
  });

  it("does not take when the standout clears 70% but another version is below 50%", () => {
    const result = determineContinuousScanConsensus(map(gated("taken", 0.8), gated("skipped_score", 0.49), gated("skipped_score", 0.6)));
    expect(result.taken).toBe(false);
  });

  it("does not take when all three are between 50% and 70%, with no standout", () => {
    const result = determineContinuousScanConsensus(map(gated("skipped_score", 0.6), gated("skipped_score", 0.55), gated("skipped_score", 0.65)));
    expect(result.taken).toBe(false);
  });

  it("takes when all three clear 70% (trivially satisfies the standout+floor rule)", () => {
    const result = determineContinuousScanConsensus(map(gated("taken", 0.72), gated("taken", 0.75), gated("taken", 0.71)));
    expect(result.taken).toBe(true);
  });

  it("falls back to the representative-order preference when the standout version's own decision is skipped_score", () => {
    // v3 is the standout at 72% but its own directional-conviction margin
    // check failed (decision stays skipped_score); v1 clears its own 65%
    // threshold and is the only version actually "taken".
    const result = determineContinuousScanConsensus(map(gated("taken", 0.66), gated("skipped_score", 0.55), gated("skipped_score", 0.72)));
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v1");
  });

  it("includes a readable summary with the standout and floor percentages", () => {
    const result = determineContinuousScanConsensus(map(gated("taken", 0.77), gated("skipped_score", 0.55), gated("skipped_score", 0.5)));
    expect(result.summary).toContain("standout 77%");
    expect(result.summary).toContain("floor 50%");
    expect(result.summary).toContain("avg=");
  });
});
