import { describe, expect, it } from "vitest";
import { timeframeAlignmentSignal, type TimeframeTrendReadings } from "../src/analytics/timeframeAlignment.js";

function up(confidence = 0.8) {
  return { trendLabel: "up" as const, confidence };
}
function down(confidence = 0.8) {
  return { trendLabel: "down" as const, confidence };
}
function none() {
  return { trendLabel: "none" as const, confidence: 0 };
}

describe("timeframeAlignmentSignal", () => {
  it("returns 0 when no timeframes have data yet", () => {
    expect(timeframeAlignmentSignal({}, "long")).toBe(0);
  });

  it("is strongly positive when every timeframe agrees with a long", () => {
    const readings: TimeframeTrendReadings = { "1d": up(), "4h": up(), "1h": up(), "30m": up(), "15m": up(), "5m": up(), "1m": up() };
    const signal = timeframeAlignmentSignal(readings, "long");
    expect(signal).toBeGreaterThan(0.5);
    expect(signal).toBeLessThanOrEqual(1);
  });

  it("is strongly negative when every timeframe fights a long", () => {
    const readings: TimeframeTrendReadings = { "1d": down(), "4h": down(), "1h": down(), "30m": down(), "15m": down(), "5m": down(), "1m": down() };
    const signal = timeframeAlignmentSignal(readings, "long");
    expect(signal).toBeLessThan(-0.5);
    expect(signal).toBeGreaterThanOrEqual(-1);
  });

  it("mirrors for a short setup", () => {
    const readings: TimeframeTrendReadings = { "1d": down(), "4h": down() };
    expect(timeframeAlignmentSignal(readings, "short")).toBeGreaterThan(0);
    expect(timeframeAlignmentSignal(readings, "long")).toBeLessThan(0);
  });

  it("stays within [-1, 1] at the extremes", () => {
    const allUp: TimeframeTrendReadings = { "1d": up(1), "4h": up(1), "1h": up(1), "30m": up(1), "15m": up(1), "5m": up(1), "1m": up(1) };
    expect(timeframeAlignmentSignal(allUp, "long")).toBeLessThanOrEqual(1);
    const allDown: TimeframeTrendReadings = { "1d": down(1), "4h": down(1), "1h": down(1), "30m": down(1), "15m": down(1), "5m": down(1), "1m": down(1) };
    expect(timeframeAlignmentSignal(allDown, "long")).toBeGreaterThanOrEqual(-1);
  });

  it("renormalizes over available legs instead of diluting toward 0 when most are missing", () => {
    // Only 1d present (the heaviest single leg) and strongly agrees -- should
    // read strongly positive, not diluted as if the 6 missing legs were neutral.
    const onlyDaily: TimeframeTrendReadings = { "1d": up(0.9) };
    const signal = timeframeAlignmentSignal(onlyDaily, "long");
    expect(signal).toBeCloseTo(0.9, 5);
  });

  it("treats a missing 4h leg as excluded, not as a fabricated 'none' reading", () => {
    // If the missing leg were counted as "none" (-0.2), the result would be
    // pulled down; excluded, it should match the equivalent all-up composite
    // computed over just the present legs.
    const withoutFourHour: TimeframeTrendReadings = { "1d": up(0.8), "1h": up(0.8) };
    const asIfFourHourWereNone: TimeframeTrendReadings = { "1d": up(0.8), "4h": none(), "1h": up(0.8) };
    expect(timeframeAlignmentSignal(withoutFourHour, "long")).toBeGreaterThan(timeframeAlignmentSignal(asIfFourHourWereNone, "long"));
  });

  it("scores a 'none' trend as a small flat penalty, not neutral", () => {
    const signal = timeframeAlignmentSignal({ "1d": none() }, "long");
    expect(signal).toBeLessThan(0);
    expect(signal).toBeGreaterThan(-0.5);
  });

  it("weights 1d more heavily than 1m when they disagree", () => {
    const dailyWins: TimeframeTrendReadings = { "1d": up(0.9), "1m": down(0.9) };
    expect(timeframeAlignmentSignal(dailyWins, "long")).toBeGreaterThan(0);
  });
});
