import { describe, expect, it } from "vitest";
import { isInTradingWeek } from "../src/analytics/tradingWeek.js";

describe("isInTradingWeek", () => {
  it("is closed all day Saturday", () => {
    expect(isInTradingWeek(new Date("2026-07-11T04:00:00Z"))).toBe(false); // Sat 12:00am ET
    expect(isInTradingWeek(new Date("2026-07-11T21:30:00Z"))).toBe(false); // Sat 5:30pm ET
  });

  it("is closed Sunday until 6pm ET, then opens", () => {
    expect(isInTradingWeek(new Date("2026-07-12T21:30:00Z"))).toBe(false); // Sun 5:30pm ET
    expect(isInTradingWeek(new Date("2026-07-12T22:30:00Z"))).toBe(true); // Sun 6:30pm ET
  });

  it("stays open through Monday", () => {
    expect(isInTradingWeek(new Date("2026-07-13T21:30:00Z"))).toBe(true); // Mon 5:30pm ET
  });

  it("closes Friday at 5pm ET", () => {
    expect(isInTradingWeek(new Date("2026-07-10T20:30:00Z"))).toBe(true); // Fri 4:30pm ET
    expect(isInTradingWeek(new Date("2026-07-10T21:30:00Z"))).toBe(false); // Fri 5:30pm ET
  });
});
