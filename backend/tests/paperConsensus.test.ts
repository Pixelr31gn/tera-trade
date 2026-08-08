import { describe, expect, it } from "vitest";
import { determineConsensus, determineContinuousScanConsensus, isSrProximityGateSuspended } from "../src/engine/loop.js";
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

// v6-solo gate (2026-08-06, operator request, superseding the v6-mandatory
// gate below; threshold lowered 30% -> 29.55% on 2026-08-07): v6 alone
// clearing the threshold is sufficient to execute -- no confirmation from
// v1/v2/v3/v5 required at all. See engine/loop.ts's
// V6_SOLO_EXECUTION_THRESHOLD comment for the tradeoffs the operator was
// told about (v6 had zero live trades behind it, both 30% and 29.55% are
// below a coin flip) before making these calls. Both determineConsensus and
// determineContinuousScanConsensus share it.
describe.each([
  ["determineConsensus", determineConsensus],
  ["determineContinuousScanConsensus", determineContinuousScanConsensus],
] as const)("%s -- v6-solo gate (2026-08-07, 29.55% threshold)", (_name, fn) => {
  it("takes when v6 clears 29.55% alone, with everything else disagreeing", () => {
    const result = fn(map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.35)));
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v6");
  });

  it("takes when a version is exactly at the 29.55% threshold", () => {
    const result = fn(map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.2955)));
    expect(result.taken).toBe(true);
  });

  // Regression guard for the real 2026-08-07 case that prompted the 30% ->
  // 29.55% change: a real NQ long scored v6=0.29773, displayed as "30%"
  // under the old whole-percent rounding, and didn't execute under the old
  // 30% threshold -- read as a bug when the gate was actually working
  // correctly. Confirms it clears the new, lower threshold.
  it("takes for the real 0.29773 NQ-long value that prompted lowering the threshold", () => {
    const result = fn(map(gated("taken", 0.71), gated("skipped_score", 0.41), gated("skipped_score", 0.75), gated("skipped_score", 0.22), gated("skipped_score", 0.29773)));
    expect(result.taken).toBe(true);
  });

  it("does not take when v1 clears 65% (even strongly) but both v3 and v6 stay below their solo thresholds", () => {
    const result = fn(map(gated("taken", 0.9), gated("skipped_score", 0.3), gated("skipped_score", 0.2), gated("skipped_score", 0.3), gated("skipped_score", 0.2)));
    expect(result.taken).toBe(false);
    expect(result.representativeVersion).toBeNull();
  });

  it("falls back through v3, v2, v1, then v5 as representative when v6's own decision isn't taken", () => {
    const v6NotOwnDecision = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.4), gated("skipped_score", 0.35)));
    // v6's probability (35%) clears the solo gate, so taken is true, but v6's
    // OWN decision reads skipped_score (blocked by its own internal checks) --
    // representative falls back to v3.
    expect(v6NotOwnDecision.taken).toBe(true);
    expect(v6NotOwnDecision.representativeVersion).toBe("v3");
  });
});

// v3-solo gate (2026-08-07, operator request, additive alongside v6-solo,
// not a replacement): v3 alone clearing 29.5% is ALSO enough to execute on
// its own -- taken = v6>=29.55% OR v3>=29.5%. Operator was told v3 typically
// scores 25-75% on these signals, so this was expected to noticeably
// increase execution frequency beyond what v6-solo alone produced. See
// engine/loop.ts's V3_SOLO_EXECUTION_THRESHOLD comment.
describe.each([
  ["determineConsensus", determineConsensus],
  ["determineContinuousScanConsensus", determineContinuousScanConsensus],
] as const)("%s -- v3-solo gate (2026-08-07, 29.5% threshold)", (_name, fn) => {
  it("takes when v3 clears 29.5% alone, with v6 and everything else below their own bars", () => {
    const result = fn(map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.4), gated("skipped_score", 0.1), gated("skipped_score", 0.2)));
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v3");
  });

  it("takes when v3 is exactly at the 29.5% threshold", () => {
    const result = fn(map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.295), gated("skipped_score", 0.1), gated("skipped_score", 0.2)));
    expect(result.taken).toBe(true);
  });

  it("does not take when v3 stays just below 29.5% and v6 also stays below its own bar", () => {
    const result = fn(map(gated("taken", 0.9), gated("skipped_score", 0.3), gated("skipped_score", 0.294), gated("skipped_score", 0.3), gated("skipped_score", 0.2)));
    expect(result.taken).toBe(false);
  });

  it("includes a readable summary with both thresholds and per-version percentages", () => {
    const result = fn(map(gated("taken", 0.8), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("taken", 0.7)));
    expect(result.summary).toContain("v3-or-v6-solo gate");
    expect(result.summary).toContain("29.5%+");
    expect(result.summary).toContain("29.55%+");
    expect(result.summary).toContain("v3=40.0%");
    expect(result.summary).toContain("v6=70.0%");
    expect(result.summary).toContain("avg v1/v2/v3=");
  });
});

// S/R proximity gate temporary suspension (2026-08-06, operator request,
// 24h-boxed) -- see engine/loop.ts's SR_PROXIMITY_GATE_SUSPENDED_UNTIL
// comment for the ES/NQ incident that prompted this.
describe("isSrProximityGateSuspended", () => {
  it("is suspended for a time before the expiry", () => {
    expect(isSrProximityGateSuspended(new Date("2026-08-07T12:00:00Z"))).toBe(true);
  });

  it("is no longer suspended once the expiry has passed", () => {
    expect(isSrProximityGateSuspended(new Date("2026-08-09T00:00:00Z"))).toBe(false);
  });
});
