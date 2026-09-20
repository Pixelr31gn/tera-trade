import { describe, expect, it } from "vitest";
import { selectSessionBestVersion, MIN_SESSION_SAMPLES_PER_VERSION, type SessionVersionStats } from "../src/scoring/sessionPerformance.js";
import type { StrategyVersion } from "../src/scoring/ruleScorer.js";

const SESSION_START = new Date("2026-08-10T13:00:00Z");

function stats(version: StrategyVersion, resolvedCount: number, winRate: number): SessionVersionStats {
  return { version, resolvedCount, winRate };
}

describe("selectSessionBestVersion", () => {
  it("is cold-start when no version has enough resolved samples this session", () => {
    const result = selectSessionBestVersion(
      new Map([
        ["v1", stats("v1", 1, 1.0)],
        ["v2", stats("v2", 2, 0.5)],
      ]),
      SESSION_START
    );
    expect(result.coldStart).toBe(true);
  });

  it("picks the highest win rate among versions that clear the sample floor", () => {
    const result = selectSessionBestVersion(
      new Map([
        ["v1", stats("v1", 5, 0.4)],
        ["v2", stats("v2", 5, 0.8)],
        ["v3", stats("v3", 5, 0.2)],
      ]),
      SESSION_START
    );
    expect(result.coldStart).toBe(false);
    expect(result.selectedVersion).toBe("v2");
  });

  it("switches on even a one-point win-rate edge, no minimum margin required", () => {
    const result = selectSessionBestVersion(
      new Map([
        ["v1", stats("v1", 10, 0.5)],
        ["v2", stats("v2", 10, 0.51)],
      ]),
      SESSION_START
    );
    expect(result.selectedVersion).toBe("v2");
  });

  it("ignores a version's high win rate if it hasn't cleared the sample floor, even when every other version has fewer samples still above it", () => {
    const result = selectSessionBestVersion(
      new Map([
        ["v1", stats("v1", MIN_SESSION_SAMPLES_PER_VERSION - 1, 1.0)], // one short of the floor
        ["v2", stats("v2", MIN_SESSION_SAMPLES_PER_VERSION, 0.3)],
      ]),
      SESSION_START
    );
    expect(result.coldStart).toBe(false);
    expect(result.selectedVersion).toBe("v2");
  });

  it("carries the session start through on both cold-start and a real selection", () => {
    const coldStart = selectSessionBestVersion(new Map([["v1", stats("v1", 0, 0)]]), SESSION_START);
    expect(coldStart.sessionStart).toBe(SESSION_START);

    const selected = selectSessionBestVersion(new Map([["v1", stats("v1", 5, 0.6)]]), SESSION_START);
    expect(selected.sessionStart).toBe(SESSION_START);
  });

  it("respects an explicit minSamplesPerVersion override", () => {
    const result = selectSessionBestVersion(new Map([["v1", stats("v1", 1, 0.9)]]), SESSION_START, 1);
    expect(result.coldStart).toBe(false);
    expect(result.selectedVersion).toBe("v1");
  });
});
