import { describe, expect, it } from "vitest";
import { classifySession, getSessionEnd, getSessionStart, TradingSession } from "../src/analytics/session.js";

function utc(hour: number): Date {
  return new Date(Date.UTC(2026, 0, 15, hour, 0, 0));
}

describe("classifySession", () => {
  it("classifies the London session (08:00-13:00 UTC)", () => {
    expect(classifySession(utc(8))).toBe(TradingSession.LONDON);
    expect(classifySession(utc(10))).toBe(TradingSession.LONDON);
    expect(classifySession(utc(12))).toBe(TradingSession.LONDON);
  });

  it("classifies the New York session (13:00-22:00 UTC), including the London/NY overlap", () => {
    expect(classifySession(utc(13))).toBe(TradingSession.NEW_YORK);
    expect(classifySession(utc(15))).toBe(TradingSession.NEW_YORK);
    expect(classifySession(utc(21))).toBe(TradingSession.NEW_YORK);
  });

  it("classifies the Asian session (22:00-24:00 and 00:00-08:00 UTC)", () => {
    expect(classifySession(utc(22))).toBe(TradingSession.ASIAN);
    expect(classifySession(utc(23))).toBe(TradingSession.ASIAN);
    expect(classifySession(utc(0))).toBe(TradingSession.ASIAN);
    expect(classifySession(utc(7))).toBe(TradingSession.ASIAN);
  });

  it("has no gaps or overlaps across all 24 hours", () => {
    for (let hour = 0; hour < 24; hour++) {
      const session = classifySession(utc(hour));
      expect(Object.values(TradingSession)).toContain(session);
    }
  });
});

describe("getSessionEnd", () => {
  it("ends London at 13:00 UTC (New York's start)", () => {
    expect(getSessionEnd(utc(10)).toISOString()).toBe(new Date(Date.UTC(2026, 0, 15, 13, 0, 0)).toISOString());
  });

  it("ends New York at 22:00 UTC (Asian's start)", () => {
    expect(getSessionEnd(utc(15)).toISOString()).toBe(new Date(Date.UTC(2026, 0, 15, 22, 0, 0)).toISOString());
  });

  it("ends the Asian session's late leg (22:00-24:00) at 08:00 UTC the NEXT day", () => {
    expect(getSessionEnd(utc(23)).toISOString()).toBe(new Date(Date.UTC(2026, 0, 16, 8, 0, 0)).toISOString());
  });

  it("ends the Asian session's early leg (00:00-08:00) at 08:00 UTC the SAME day", () => {
    expect(getSessionEnd(utc(3)).toISOString()).toBe(new Date(Date.UTC(2026, 0, 15, 8, 0, 0)).toISOString());
  });

  it("always lands after getSessionStart for the same instant, across all 24 hours", () => {
    for (let hour = 0; hour < 24; hour++) {
      const at = utc(hour);
      expect(getSessionEnd(at).getTime()).toBeGreaterThan(getSessionStart(at).getTime());
    }
  });
});
