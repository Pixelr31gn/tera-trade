/**
 * Trading session classification (New York / London / Asian), so trade
 * history can be analyzed and modeled separately per session rather than as
 * one combined dataset -- each session has genuinely different volume,
 * volatility, and price-action character.
 *
 * Real market sessions overlap (London/NY overlap 13:00-16:00 UTC is
 * actually the highest-volume window of the day), but every trade needs
 * exactly one session label, so this uses a fixed non-overlapping UTC split:
 *   Asian:     00:00-08:00 UTC, plus 22:00-24:00 UTC (pre-Asian-open carryover)
 *   London:    08:00-13:00 UTC
 *   New York:  13:00-22:00 UTC (includes the London/NY overlap)
 */
export const TradingSession = {
  NEW_YORK: "new_york",
  LONDON: "london",
  ASIAN: "asian",
} as const;
export type TradingSession = (typeof TradingSession)[keyof typeof TradingSession];

export function classifySession(time: Date): TradingSession {
  const hour = time.getUTCHours();
  if (hour >= 8 && hour < 13) return TradingSession.LONDON;
  if (hour >= 13 && hour < 22) return TradingSession.NEW_YORK;
  return TradingSession.ASIAN; // 22:00-24:00 and 00:00-08:00
}

/**
 * Start (UTC) of the session `time` currently falls in -- for windowing
 * "this session's" stats, e.g. scoring/sessionPerformance.ts's rolling
 * session-performance consensus gate. London/New York both start and end
 * within the same UTC calendar day; Asian wraps midnight (22:00 UTC one day
 * through 08:00 UTC the next), so when `time`'s hour is before 08:00 its
 * session actually started the PREVIOUS day at 22:00.
 */
export function getSessionStart(time: Date): Date {
  const session = classifySession(time);
  const start = new Date(time);
  if (session === TradingSession.LONDON) {
    start.setUTCHours(8, 0, 0, 0);
  } else if (session === TradingSession.NEW_YORK) {
    start.setUTCHours(13, 0, 0, 0);
  } else {
    if (time.getUTCHours() < 8) start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCHours(22, 0, 0, 0);
  }
  return start;
}

/**
 * End (UTC) of the session `time` currently falls in -- i.e. the start of
 * the NEXT session in sequence (London -> New York -> Asian -> London...).
 * For dealer-level outcome tracking (engine/dealerLevelOutcomeEvaluator.ts):
 * a session-scoped GEX snapshot's natural "did it hold" lookforward window
 * is exactly the rest of that session, matching how these levels are
 * actually talked about ("overnight," "into the close").
 */
export function getSessionEnd(time: Date): Date {
  const session = classifySession(time);
  const end = new Date(time);
  if (session === TradingSession.LONDON) {
    end.setUTCHours(13, 0, 0, 0); // London -> New York
  } else if (session === TradingSession.NEW_YORK) {
    end.setUTCHours(22, 0, 0, 0); // New York -> Asian
  } else {
    // Asian ends at 08:00 UTC -- same day if `time` is already past midnight
    // (hour < 8), next day if `time` is still in the 22:00-24:00 leg.
    if (time.getUTCHours() >= 22) end.setUTCDate(end.getUTCDate() + 1);
    end.setUTCHours(8, 0, 0, 0);
  }
  return end;
}
