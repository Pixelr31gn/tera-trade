import { describe, expect, it } from "vitest";
import { determineConsensus, determineContinuousScanConsensus } from "../src/engine/loop.js";
import type { GatedScore } from "../src/scoring/gate.js";
import type { StrategyVersion } from "../src/scoring/ruleScorer.js";

function gated(decision: "taken" | "skipped_score", probability: number): GatedScore {
  return { probability, decision, factors: [], modelUsed: "rule_v1", blockReason: null, v3Bucket: null };
}

function map(v1: GatedScore, v2: GatedScore, v3: GatedScore, v5: GatedScore = gated("taken", 0.8)): Map<StrategyVersion, GatedScore> {
  return new Map([
    ["v1", v1],
    ["v2", v2],
    ["v3", v3],
    ["v5", v5],
  ]);
}

// Mutual-agreement rule (2026-07-29, operator request, revised twice the same
// day): went from a looser "top 2 of 3 clear 75%, weakest just needs 56%"
// shape, to a stricter "all three of v1/v2/v3 unanimously, plus v5 also
// clears 75%" shape -- confirmed live that stricter version was far too
// strict (each version individually only clears 75%+ ~7-12% of the time;
// requiring all four simultaneously produced zero actionable recommendations
// and zero trades over several hours). Landed here: v5 -- otherwise
// shadow-only, see engine/loop.ts's SHADOW_ONLY_VERSIONS -- must
// independently clear its own 75% gate, AND at least ONE (not all three) of
// v1/v2/v3 must also clear the same bar. v5 doesn't "vote" the way v1/v2/v3
// do (no representative-explanation slot, excluded from the averaged
// probability) -- it's a hard AND-gate alongside whichever single v1/v2/v3
// version confirms. Both determineConsensus and determineContinuousScanConsensus
// share this exact rule.
describe.each([
  ["determineConsensus", determineConsensus],
  ["determineContinuousScanConsensus", determineContinuousScanConsensus],
] as const)("%s -- mutual-agreement rule (2026-07-29 operator request, revised to a single v1/v2/v3 confirmation)", (_name, fn) => {
  it("takes when all three of v1/v2/v3 clear 75% and v5 also clears 75%", () => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.76), gated("taken", 0.77), gated("taken", 0.75)));
    expect(result.taken).toBe(true);
  });

  it("takes when only ONE of v1/v2/v3 clears 75%, as long as v5 also clears its own gate", () => {
    const v1Alone = fn(map(gated("taken", 0.8), gated("skipped_score", 0.6), gated("skipped_score", 0.6), gated("taken", 0.8)));
    expect(v1Alone.taken).toBe(true);
    const v3Alone = fn(map(gated("skipped_score", 0.6), gated("skipped_score", 0.6), gated("taken", 0.8), gated("taken", 0.8)));
    expect(v3Alone.taken).toBe(true);
  });

  it("does not take when none of v1/v2/v3 clear 75%, even if all three are moderately high and v5 clears its own gate", () => {
    const result = fn(map(gated("skipped_score", 0.74), gated("skipped_score", 0.7), gated("skipped_score", 0.65), gated("taken", 0.8)));
    expect(result.taken).toBe(false);
    expect(result.representativeVersion).toBeNull();
  });

  it("does not take when v1/v2/v3 all clear 75% but v5 is below its own 75% gate", () => {
    const result = fn(map(gated("taken", 0.9), gated("taken", 0.85), gated("taken", 0.8), gated("skipped_score", 0.7)));
    expect(result.taken).toBe(false);
  });

  it("does not take when a lone v1/v2/v3 version clears 75% but v5 is below its own gate", () => {
    const result = fn(map(gated("taken", 0.9), gated("skipped_score", 0.6), gated("skipped_score", 0.6), gated("skipped_score", 0.7)));
    expect(result.taken).toBe(false);
  });

  it("takes when v5 is exactly at its 75% gate threshold", () => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.75)));
    expect(result.taken).toBe(true);
  });

  it("counts a version toward mutual agreement by raw probability, even if its own decision is skipped (v3's extra directional-conviction gate)", () => {
    // v3 scores 80% (clears the confirmation requirement) but its own
    // decision is skipped_score (e.g. blocked by the directional-conviction
    // margin check in gate.ts) -- it still counts toward mutual agreement
    // here since the raw probability is what the rule checks, not decision.
    // v1's own raw probability (60%) would NOT itself clear the bar, but its
    // decision is "taken" -- it becomes the representative purely because
    // it's the only one of the three with a "taken" decision.
    const result = fn(map(gated("taken", 0.6), gated("skipped_score", 0.6), gated("skipped_score", 0.8), gated("taken", 0.8)));
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v1");
  });

  it("prefers v3 as the representative version when it agrees, falling back to v2 then v1", () => {
    const allTaken = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8)));
    expect(allTaken.representativeVersion).toBe("v3");

    const noV3 = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.6)));
    expect(noV3.taken).toBe(false); // v5 gate not cleared -- confirms representativeVersion isn't reachable without it
  });

  it("includes a readable summary with the mutual-agreement thresholds, per-version percentages, and v5's own score", () => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.76), gated("taken", 0.77), gated("taken", 0.9)));
    expect(result.summary).toContain("75%+");
    expect(result.summary).toContain("avg=");
    expect(result.summary).toContain("v1=");
    expect(result.summary).toContain("v2=");
    expect(result.summary).toContain("v3=");
    expect(result.summary).toContain("v5=");
  });
});
