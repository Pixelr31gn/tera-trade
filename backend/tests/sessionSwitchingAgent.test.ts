import { describe, expect, it } from "vitest";
import { selectSwitchingVersion, MIN_TAKEN_RESOLVED_SAMPLES, type SwitchingVersionStats } from "../src/scoring/sessionSwitchingAgent.js";
import type { StrategyVersion } from "../src/scoring/ruleScorer.js";
import { TradingSession } from "../src/analytics/session.js";

function stats(version: StrategyVersion, takenResolved: number, takenWinRate: number, standardError: number): SwitchingVersionStats {
  return { version, takenResolved, takenWinRate, standardError };
}

describe("selectSwitchingVersion", () => {
  it("is cold-start when no version has cleared the sample floor", () => {
    const result = selectSwitchingVersion(
      TradingSession.NEW_YORK,
      new Map([
        ["v1", stats("v1", 50, 0.4, 0.07)],
        ["v2", stats("v2", 30, 0.6, 0.09)],
      ])
    );
    expect(result.reason).toBe("cold_start");
    expect(result.selectedVersion).toBeNull();
  });

  it("is cold-start when only ONE version has cleared the sample floor -- a lone candidate is never selected, even with a high win rate", () => {
    const result = selectSwitchingVersion(
      TradingSession.NEW_YORK,
      new Map([
        ["v1", stats("v1", MIN_TAKEN_RESOLVED_SAMPLES, 0.9, 0.03)],
        ["v2", stats("v2", MIN_TAKEN_RESOLVED_SAMPLES - 1, 0.9, 0.03)],
      ])
    );
    expect(result.reason).toBe("cold_start");
    expect(result.selectedVersion).toBeNull();
  });

  it("does not select when two candidates are eligible but their win rates are within one standard error of each other (no statistical margin)", () => {
    const result = selectSwitchingVersion(
      TradingSession.NEW_YORK,
      new Map([
        ["v1", stats("v1", 200, 0.3, 0.032)],
        ["v2", stats("v2", 200, 0.32, 0.033)],
      ])
    );
    expect(result.reason).toBe("no_statistical_margin");
    expect(result.selectedVersion).toBeNull();
  });

  it("selects the leader once it clears the sample floor AND is separated from the runner-up by non-overlapping ~1 SE bands", () => {
    const result = selectSwitchingVersion(
      TradingSession.NEW_YORK,
      new Map([
        ["v1", stats("v1", 200, 0.2, 0.028)],
        ["v2", stats("v2", 200, 0.5, 0.035)],
        ["v3", stats("v3", 50, 0.9, 0.04)], // high win rate but below the sample floor -- must be ignored
      ])
    );
    expect(result.reason).toBe("selected");
    expect(result.selectedVersion).toBe("v2");
  });

  it("picks the highest-win-rate eligible version among 3+ eligible candidates when the margin clears against the runner-up", () => {
    const result = selectSwitchingVersion(
      TradingSession.LONDON,
      new Map([
        ["v1", stats("v1", 300, 0.25, 0.025)],
        ["v3", stats("v3", 300, 0.28, 0.026)],
        ["v7", stats("v7", 300, 0.45, 0.029)],
      ])
    );
    expect(result.reason).toBe("selected");
    expect(result.selectedVersion).toBe("v7");
  });

  it("carries the session and full statsByVersion through on every branch", () => {
    const coldStart = selectSwitchingVersion(TradingSession.ASIAN, new Map([["v1", stats("v1", 0, 0, 0)]]));
    expect(coldStart.session).toBe(TradingSession.ASIAN);
    expect(coldStart.statsByVersion.size).toBe(1);

    const selected = selectSwitchingVersion(
      TradingSession.ASIAN,
      new Map([
        ["v1", stats("v1", 200, 0.2, 0.028)],
        ["v2", stats("v2", 200, 0.5, 0.035)],
      ])
    );
    expect(selected.session).toBe(TradingSession.ASIAN);
    expect(selected.statsByVersion.size).toBe(2);
  });
});
