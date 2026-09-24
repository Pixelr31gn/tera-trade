import { describe, expect, it } from "vitest";
import { determineConsensus, determineContinuousScanConsensus, isSrProximityGateSuspended } from "../src/engine/loop.js";
import type { GatedScore } from "../src/scoring/gate.js";
import type { StrategyVersion } from "../src/scoring/ruleScorer.js";
import type { SessionPerformanceSelection, SessionVersionStats } from "../src/scoring/sessionPerformance.js";
import type { TradingSession } from "../src/analytics/session.js";

// Every existing describe.each block below is about determineConsensus's
// session-best-version/v7-solo behavior, not the Asian-only v6-v7-only
// restriction (2026-08-13) -- pinning "new_york" here keeps them all
// unrestricted, exactly as they were before that restriction existed,
// without threading a 3rd argument through 19 individual call sites. The
// restriction itself gets its own dedicated describe block further down,
// calling the real functions directly with "asian"/"london"/"new_york".
const NEW_YORK: TradingSession = "new_york";
function unrestricted(
  fn: (m: Map<StrategyVersion, GatedScore>, s: SessionPerformanceSelection, session: TradingSession) => ReturnType<typeof determineConsensus>
) {
  return (m: Map<StrategyVersion, GatedScore>, s: SessionPerformanceSelection) => fn(m, s, NEW_YORK);
}

function gated(decision: "taken" | "skipped_score", probability: number): GatedScore {
  return { probability, decision, factors: [], modelUsed: "rule_v1", blockReason: null, v3Bucket: null };
}

// v7 defaults to a low, non-qualifying score so every existing test case
// (written before v7-solo existed) keeps behaving identically without having
// to thread a 6th argument through each call.
function map(v1: GatedScore, v2: GatedScore, v3: GatedScore, v5: GatedScore, v6: GatedScore, v7: GatedScore = gated("skipped_score", 0.1)): Map<StrategyVersion, GatedScore> {
  return new Map([
    ["v1", v1],
    ["v2", v2],
    ["v3", v3],
    ["v5", v5],
    ["v6", v6],
    ["v7", v7],
  ]);
}

// Cold-start fixture (2026-08-10, session-best-version gate -- see
// scoring/sessionPerformance.ts and engine/loop.ts's
// hasSessionBestVersionAgreement): determineConsensus/
// determineContinuousScanConsensus now require a SessionPerformanceSelection
// argument. Every existing test below passes this fixed coldStart:true
// fixture, which makes hasSessionBestVersionAgreement fall straight back to
// the plain hasV1V2V3MajorityAgreement rule these tests were originally
// written against -- so every pre-session-gate assertion keeps passing
// completely unchanged. That's a real, cheap proof the cold-start fallback
// wiring through determineConsensus's new signature is correct, not just a
// compile-time formality.
const COLD_START: SessionPerformanceSelection = {
  sessionStart: new Date("2026-08-10T13:00:00Z"),
  selectedVersion: "v1",
  coldStart: true,
  statsByVersion: new Map(),
};

function sessionStats(version: StrategyVersion, resolvedCount: number, winRate: number): SessionVersionStats {
  return { version, resolvedCount, winRate };
}

// A live session-performance selection (coldStart: false) -- selectedVersion
// is set directly rather than run through selectSessionBestVersion's own
// ranking, since these tests are about determineConsensus's *consumption* of
// a selection result, not about re-deriving
// scoring/sessionPerformance.test.ts's own selection-logic coverage.
function sessionSelected(selectedVersion: StrategyVersion): SessionPerformanceSelection {
  return {
    sessionStart: new Date("2026-08-10T13:00:00Z"),
    selectedVersion,
    coldStart: false,
    statsByVersion: new Map([
      ["v1", sessionStats("v1", 10, 0.4)],
      ["v2", sessionStats("v2", 10, 0.4)],
      ["v3", sessionStats("v3", 10, 0.4)],
      ["v6", sessionStats("v6", 10, 0.4)],
      ["v7", sessionStats("v7", 10, 0.4)],
      [selectedVersion, sessionStats(selectedVersion, 10, 0.6)],
    ]),
  };
}

// v1/v2/v3 majority vote, "tera trade 1.2 rules": at least 2 of v1/v2/v3
// individually clear 65% (LOOSE_GATE_THRESHOLD). This is what the
// session-best-version gate falls back to on cold-start (COLD_START above,
// see engine/loop.ts's hasV1V2V3MajorityAgreement comment) -- these tests
// are unchanged from before the session gate existed, and still directly
// cover that fallback logic.
describe.each([
  ["determineConsensus", unrestricted(determineConsensus)],
  ["determineContinuousScanConsensus", unrestricted(determineContinuousScanConsensus)],
] as const)("%s -- v1/v2/v3 majority vote, session-gate cold-start fallback", (_name, fn) => {
  it("takes when 2 of v1/v2/v3 clear 65%, with v5/v6/v7 all disagreeing", () => {
    const result = fn(map(gated("taken", 0.7), gated("taken", 0.66), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1)), COLD_START);
    expect(result.taken).toBe(true);
  });

  it("takes when all 3 of v1/v2/v3 clear 65%", () => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.1), gated("skipped_score", 0.1)), COLD_START);
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v3");
  });

  it("does not take when only 1 of v1/v2/v3 clears 65%, no matter how high its score is, with everything else quiet", () => {
    const result = fn(map(gated("taken", 0.99), gated("skipped_score", 0.3), gated("skipped_score", 0.2), gated("skipped_score", 0.3), gated("skipped_score", 0.2)), COLD_START);
    expect(result.taken).toBe(false);
    expect(result.representativeVersion).toBeNull();
  });

  it("does not take when none of v1/v2/v3 clear 65%, even if all three are moderately high", () => {
    const result = fn(map(gated("skipped_score", 0.64), gated("skipped_score", 0.6), gated("skipped_score", 0.5), gated("skipped_score", 0.1), gated("skipped_score", 0.1)), COLD_START);
    expect(result.taken).toBe(false);
  });

  it("includes a readable cold-start summary naming the majority-vote fallback", () => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.7), gated("skipped_score", 0.4), gated("skipped_score", 0.4), gated("skipped_score", 0.3)), COLD_START);
    expect(result.summary).toContain("session-best-version gate");
    expect(result.summary).toContain("cold-start");
    expect(result.summary).toContain("falling back to plain v1/v2/v3 majority vote");
  });
});

// Session-best-version gate (2026-08-10, operator request): once a session
// clears scoring/sessionPerformance.ts's cold-start floor,
// hasSessionBestVersionAgreement gates on ONLY the session's best-performing
// version's own probability at LOOSE_GATE_THRESHOLD -- the plain "2 of 3"
// majority-vote rule above no longer applies once a session has enough
// evidence, even if two OTHER non-selected versions both clear 65% on their
// own. This gate REPLACES v6-solo/v7-solo/the contextual bandit leg
// entirely (all three superseded, kept unused in engine/loop.ts for a
// one-line revert) -- a single selected version is now the sole gate.
describe.each([
  ["determineConsensus", unrestricted(determineConsensus)],
  ["determineContinuousScanConsensus", unrestricted(determineContinuousScanConsensus)],
] as const)("%s -- session-best-version gate (2026-08-10, coldStart: false)", (_name, fn) => {
  it("takes when the session-best version (v2) clears 65% alone, even though v1 and v3 both stay below it", () => {
    const result = fn(
      map(gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.5), gated("skipped_score", 0.1), gated("skipped_score", 0.1)),
      sessionSelected("v2")
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v2");
  });

  it("does not take when the session-best version (v2) stays below 65%, even though v1 and v3 (NOT selected) both individually clear it -- the plain majority-vote rule does not apply once a version has been selected for this session", () => {
    const result = fn(
      map(gated("taken", 0.9), gated("skipped_score", 0.4), gated("taken", 0.9), gated("skipped_score", 0.1), gated("skipped_score", 0.1)),
      sessionSelected("v2")
    );
    expect(result.taken).toBe(false);
  });

  it("can select v6 as the session's best performer and gate at 65% (not v6-solo's old, now-superseded 29.5% bar)", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.7)),
      sessionSelected("v6")
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v6");
  });

  it("does not take when session-best v6 stays below 65%, even at a probability that would have cleared v6-solo's old 29.5% bar -- that separate escape hatch is superseded, not still independently active", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.35)),
      sessionSelected("v6")
    );
    expect(result.taken).toBe(false);
  });

  it("does not take when session-best v7 stays below 65% and no other leg is cleared either", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.64)),
      sessionSelected("v7")
    );
    expect(result.taken).toBe(false);
  });

  it("prefers the session-selected version as representative even when v6/v7 also independently agree", () => {
    const result = fn(
      map(gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.5), gated("skipped_score", 0.1), gated("taken", 0.9), gated("taken", 0.9)),
      sessionSelected("v2")
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v2");
  });

  it("includes the session start and selected version's win rate in the summary", () => {
    const result = fn(
      map(gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.5), gated("skipped_score", 0.1), gated("skipped_score", 0.1)),
      sessionSelected("v2")
    );
    expect(result.summary).toContain("session-best-version gate");
    expect(result.summary).toContain("best performer this session is v2");
    expect(result.summary).toContain("v2=60.0%win");
  });
});

// v7-solo REACTIVATED (2026-08-11, operator request: "v7 is still in shadow
// mode only and i want it to be executable on live trading now i understand
// the risk") -- v7 clearing 65% completely on its own is now an ADDITIONAL
// OR'd leg alongside the session-best-version gate above, not a replacement:
// taken = hasSessionBestVersionAgreement(...) || hasV7SoloAgreement(...).
// Unlike the session gate, this leg does not care which version the session
// currently favors, and applies during cold-start too (it's independent of
// sessionSelection entirely).
describe.each([
  ["determineConsensus", unrestricted(determineConsensus)],
  ["determineContinuousScanConsensus", unrestricted(determineContinuousScanConsensus)],
] as const)("%s -- v7-solo gate RETIRED 2026-09-23 (session-best is the sole decider)", (_name, fn) => {
  // Each of the three cases below asserted taken=true until 2026-09-23, when
  // the operator made the session-best-version gate the sole decider ("Yes --
  // remove the v7-solo bypass"). They are kept, inverted, rather than deleted:
  // they are the regression guard that the bypass has not crept back, and the
  // record of exactly what it used to permit.
  it("does NOT take when v7 clears 65% alone but is not the session-selected version", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.3), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.7)),
      sessionSelected("v2") // v2 is session-best but only scores 30% here -- session leg rejects, and nothing else may fire
    );
    expect(result.taken).toBe(false);
  });

  it("does NOT take during cold-start on v7 alone -- the majority-vote fallback is the only path", () => {
    const result = fn(
      map(gated("skipped_score", 0.3), gated("skipped_score", 0.2), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.7)),
      COLD_START
    );
    expect(result.taken).toBe(false);
  });

  it("does NOT take when v7 sits exactly at the old 65% bypass threshold", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.65)),
      COLD_START
    );
    expect(result.taken).toBe(false);
  });

  it("does not take when v7 stays just below 65% and no other leg clears either", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.649)),
      COLD_START
    );
    expect(result.taken).toBe(false);
  });

  it("still prefers the session-selected version as representative when the session gate is what actually fired, even though v7 also independently clears its own bar", () => {
    const result = fn(
      map(gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.5), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.9)),
      sessionSelected("v2")
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v2");
  });

  it("includes the v7-solo leg in the summary regardless of session state", () => {
    const coldResult = fn(map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.7)), COLD_START);
    expect(coldResult.summary).toContain("OR v7 needs 65%+ alone regardless of session standing");

    const sessionResult = fn(
      map(gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.5), gated("skipped_score", 0.1), gated("skipped_score", 0.1)),
      sessionSelected("v2")
    );
    expect(sessionResult.summary).toContain("OR v7 needs 65%+ alone regardless of session standing");
  });
});

// Asian-only v6-v7-only restriction -- introduced 2026-08-13 (operator
// request: "block all executions during Asian session... only execute v6 or
// v7 during asian and london session", corrected the same day: "the only
// session it should block is asia until londons session starts"), tightened
// 2026-08-17 ("v7 shouldn't fire in asia ever") -- and turned OFF entirely
// 2026-09-01 (operator request: "turn that Asia restriction off", triggered
// by a real missed NQ short during Asian that scored v1=91.2%/v2=93.0%/
// v3=72.8%, all three genuinely agreeing, rejected outright purely for not
// being v6/v7 -- see engine/loop.ts's isV6V7OnlySession for the full
// history). Asian now uses the exact same rule as every other session; these
// tests assert THAT, not the old restriction -- calls the real functions
// directly with the actual session string, not through the `unrestricted`
// wrapper above, so a regression that silently reintroduces a session-specific
// carve-out would be caught here.
describe.each([
  ["determineConsensus", determineConsensus],
  ["determineContinuousScanConsensus", determineContinuousScanConsensus],
] as const)("%s -- asian session is unrestricted (2026-09-01)", (_name, fn) => {
  it("allows a session-best v3 during asian, same as any other session", () => {
    const result = fn(
      map(gated("skipped_score", 0.5), gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.1), gated("skipped_score", 0.1)),
      sessionSelected("v3"),
      "asian"
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v3");
  });

  it("allows the cold-start v1/v2/v3 majority-vote fallback during asian when 3 of 3 clear 65%", () => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.1), gated("skipped_score", 0.1)), COLD_START, "asian");
    expect(result.taken).toBe(true);
  });

  it("allows a session-best v6 during asian", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.7)),
      sessionSelected("v6"),
      "asian"
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v6");
  });

  it("allows a session-best v7 during asian", () => {
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.7)),
      sessionSelected("v7"),
      "asian"
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v7");
  });

  it("does NOT execute during asian when the session-best version fails its own bar, even with v7 at 70%", () => {
    // v3 is session-best but only scored 50% -- below LOOSE_GATE_THRESHOLD
    // (65%), so the session-best-version gate does not pass. This case existed
    // to isolate the v7-solo escape hatch as the reason taken was true; with
    // that leg retired (2026-09-23) it now isolates the opposite -- v7 at 70%
    // buys nothing when it is not the session's selected version.
    const result = fn(
      map(gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("skipped_score", 0.5), gated("skipped_score", 0.1), gated("skipped_score", 0.1), gated("taken", 0.7)),
      sessionSelected("v3"),
      "asian"
    );
    expect(result.taken).toBe(false);
  });

  it.each([["london"], ["new_york"], ["asian"]] as const)("behaves identically during %s -- a session-best v3 executes", (session) => {
    const result = fn(
      map(gated("skipped_score", 0.5), gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.1), gated("skipped_score", 0.1)),
      sessionSelected("v3"),
      session
    );
    expect(result.taken).toBe(true);
    expect(result.representativeVersion).toBe("v3");
  });

  it.each([["london"], ["new_york"], ["asian"]] as const)("behaves identically during %s -- the cold-start v1/v2/v3 majority vote applies", (session) => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.1), gated("skipped_score", 0.1)), COLD_START, session);
    expect(result.taken).toBe(true);
  });

  it("never mentions the old v6/v7-only restriction in the summary during asian", () => {
    const result = fn(
      map(gated("skipped_score", 0.5), gated("skipped_score", 0.5), gated("taken", 0.7), gated("skipped_score", 0.1), gated("skipped_score", 0.1)),
      sessionSelected("v3"),
      "asian"
    );
    expect(result.summary).not.toContain("execution restricted to v6/v7 only");
    expect(result.summary).not.toContain("NOT honored (not v6/v7)");
  });

  it("never mentions the restriction in the cold-start summary during asian", () => {
    const result = fn(map(gated("taken", 0.8), gated("taken", 0.8), gated("taken", 0.8), gated("skipped_score", 0.1), gated("skipped_score", 0.1)), COLD_START, "asian");
    expect(result.summary).not.toContain("execution restricted to v6/v7 only");
    expect(result.summary).not.toContain("blocked entirely this session");
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
