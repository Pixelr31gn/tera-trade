/**
 * Is this chat message asking for the daily trading plan to be (re)built?
 * (2026-10-05 -- see api/routes/assistant.ts, which routes a match through
 * dailyPlanScheduler.ts's buildDailyPlanNow instead of plain chat.)
 *
 * Deliberately narrow: it has to be a request to make or update a plan. A
 * question that merely mentions the plan ("what is today's plan?", "why did
 * the plan block that trade?") still goes to ordinary chat.
 */
export function isDailyPlanRequest(message: string): boolean {
  const m = message.toLowerCase().trim();
  if (/^(what|why|how|when|where|which|is|are|does|did|do|can|could|explain|show|tell)\b/.test(m)) return false;
  if (/\b(update|refresh|rebuild|redo|build|make|create|set|run|generate|execute)\b[^.?!]{0,40}\bplan\b/.test(m)) return true;
  // A bare noun phrase that ENDS in "... plan" ("daily plan", "Asian session
  // daily trading plan") is the operator naming the thing they want done.
  return /^[a-z' ]{0,40}\b(daily|trading|session|today'?s?)\s+(trading\s+)?plan\s*[.!]*$/.test(m);
}
