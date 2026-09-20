/**
 * Context bucket key for the v1/v2/v3 consensus bandit (scoring/consensusBandit.ts)
 * -- session x intraday trend x intraday volatility, coarser than
 * ruleScorerV3.ts's computeV3Bucket (3 inputs, not 6) since the point here is
 * comparing v1/v2/v3 *within* a bucket, and a bigger key space needs more
 * samples per cell before the bandit has anything to learn from. No symbol
 * dimension -- buckets deliberately pool across instruments to maximize early
 * sample size; splitting by symbol too is a trivial follow-up if evidence
 * ever says buckets should be instrument-specific.
 */
import type { TradingSession } from "./session.js";

export function computeContextBucket(
  session: TradingSession,
  trendLabel: "up" | "down" | "none",
  volLabel: "high" | "normal" | "low"
): string {
  return [session, trendLabel, volLabel].join(":");
}
