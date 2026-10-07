import { describe, expect, it } from "vitest";
import { isDailyPlanRequest } from "../src/assistant/planIntent.js";

describe("isDailyPlanRequest", () => {
  it.each([
    "update trading plan",
    "Update the trading plan",
    "run the daily trading plan",
    "make a new plan for the asian session",
    "build today's plan",
    "refresh plan",
    "Asian session daily trading plan",
    "daily plan",
    "execute the Asian session daily trading plan",
  ])("routes %j to the plan builder", (message) => {
    expect(isDailyPlanRequest(message)).toBe(true);
  });

  it.each([
    "what is today's plan?",
    "why did the plan block my NQ long?",
    "show me the daily plan",
    "close my NQ position",
    "how is the trading going",
    "explain the trading plan zones",
  ])("leaves %j to ordinary chat", (message) => {
    expect(isDailyPlanRequest(message)).toBe(false);
  });
});
