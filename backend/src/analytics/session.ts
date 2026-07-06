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
