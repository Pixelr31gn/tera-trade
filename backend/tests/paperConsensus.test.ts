import { describe, expect, it } from "vitest";
import { determineConsensus, determineContinuousScanConsensus } from "../src/engine/loop.js";
import type { GatedScore } from "../src/scoring/gate.js";
import type { StrategyVersion } from "../src/scoring/ruleScorer.js";

function gated(decision: "taken" | "skipped_score", probability: number): GatedScore {
  return { probability, decision, factors: [], modelUsed: "rule_v1", blockReason: null, v3Bucket: null };
}

function map(v1: GatedScore, v2: GatedScore, v3: GatedScore, v5: GatedScore, v6: GatedScore): Map<StrategyVersion, GatedScore> {
  return new Map([
    ["v1", v1],
    ["v2", v2],
    ["v3", v3],
    ["v5", v5],
    ["v6", v6],
  ]);
}

// v6-mandatory gate (2026-08-02, operator request, made while live with
// DRY_RUN_ORDERS=false): v6 must independently clear 65% AND at least one of
// v1/v2/v3/v5 must also clear 65% -- v6 can't execute alone, and neither can
// any of v1/v2/v3/v5 without v6's agreement. Same anchor-plus-confirmation
// shape as the original mutual-agreement rule, with v6 in the anchor role.
// Both determineConsensus and determineContinuousScanConsensus share it.
describe.each([
  ["determineConsensus", determineConsensus],
  ["determineContinuousScanConsensus", determineContinuousScanConsensus],
] as const)("%s -- v6-mandatory gate (2026-08-02)", (_name, fn) => {
  it("takes when v6 clears 65% and v1 also clears 65%", () => {
    const result = fn(map(gated("taken", 0.8), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("taken", 0.7)));
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v6");
  });

  it("does not take when v6 clears 65% but none of v1/v2/v3/v5 do", () => {
    const result = fn(map(gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("taken", 0.7)));
    expect(result.taken).toBe(false);
    expect(result.representativeVersion).toBeNull();
  });

  it("does not take when v1 clears 65% (even strongly) but v6 does not -- the exact case the any-single-version gate used to allow", () => {
    const result = fn(map(gated("taken", 0.9), gated("skipped_score", 0.3), gated("skipped_score", 0.3), gated("skipped_score", 0.3), gated("skipped_score", 0.5)));
    expect(result.taken).toBe(false);
  });

  it("takes when a version is exactly at the 65% threshold on both sides", () => {
    const result = fn(map(gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("taken", 0.65), gated("taken", 0.65)));
    expect(result.taken).toBe(true);
  });

  it("prefers v6 as the representative version, falling back to v3, v2, v1, then v5", () => {
    const allTaken = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.4), gated("taken", 0.8)));
    expect(allTaken.representativeVersion).toBe("v6");

    const v6NotTaken = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.4), gated("skipped_score", 0.7)));
    // v6's raw probability (70%) still counts toward the "at least one other" leg's
    // own agreement check on v1/v2/v3/v5, but here it's v1 clearing 65% that
    // satisfies that leg, and v6 clearing 65% (0.7) satisfies the anchor --
    // taken should be true, with v3 as representative since v6's own decision
    // reads skipped_score.
    expect(v6NotTaken.taken).toBe(true);
    expect(v6NotTaken.representativeVersion).toBe("v3");
  });

  it("includes a readable summary with both thresholds, per-version percentages, and which of v1/v2/v3/v5 agreed", () => {
    const result = fn(map(gated("taken", 0.8), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("taken", 0.7)));
    expect(result.summary).toContain("v6-mandatory gate");
    expect(result.summary).toContain("65%+");
    expect(result.summary).toContain("v6=70%");
    expect(result.summary).toContain("avg=");
    expect(result.summary).toContain("agreeing: v1");
  });
});
