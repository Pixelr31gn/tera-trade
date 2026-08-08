/**
 * Step 3 of the v3 spec: "compare a new recommendation against the previous
 * 5-15 completed recommendations with similar market conditions, and adjust
 * confidence by how well those actually performed." This is the only part
 * of v3 that needs a DB round-trip, so it's deliberately kept separate from
 * the pure scoring math in ruleScorerV3.ts.
 *
 * Historical data adjusts confidence, it never overrides it: the adjustment
 * is capped at +/-15 points (on the 0-100 scale) and requires at least 5
 * similar, resolved samples before it applies at all -- below that, recent
 * history is too thin to mean anything, so the adjustment is 0.
 */
import { prisma } from "../db/client.js";

const MIN_SIMILAR_SAMPLES = 5;
const MAX_SIMILAR_SAMPLES = 15;
const MAX_ADJUSTMENT_POINTS = 15;
// Scales how strongly the similar-setups win rate moves the score: a 73%
// win rate over similar setups nudges the score by (0.73-0.5)*30 ~= +7
// points, matching the worked example in the spec. Hand-set to reproduce
// that example, not fitted.
const ADJUSTMENT_SCALE = 30;

const RESOLVED_OUTCOME_LABELS = ["executed_win", "executed_loss", "missed_win", "missed_loss"];
const POSITIVE_OUTCOME_LABELS = new Set(["executed_win", "missed_win"]);

export interface HistoricalAdjustment {
  adjustmentPoints: number;
  sampleSize: number;
  winRate: number | null;
}

/** Pure -- no DB access -- so it can be unit-tested directly (see tests/ruleScorerV3.test.ts). Kept separate from the DB query below, same split as analytics/fixedTargetEdge.ts's summarizeFixedTargetOutcomes. */
export function computeAdjustmentFromOutcomes(outcomeLabels: (string | null)[]): HistoricalAdjustment {
  if (outcomeLabels.length < MIN_SIMILAR_SAMPLES) {
    return { adjustmentPoints: 0, sampleSize: outcomeLabels.length, winRate: null };
  }

  const wins = outcomeLabels.filter((label) => label && POSITIVE_OUTCOME_LABELS.has(label)).length;
  const winRate = wins / outcomeLabels.length;
  const adjustmentPoints = Math.max(-MAX_ADJUSTMENT_POINTS, Math.min(MAX_ADJUSTMENT_POINTS, (winRate - 0.5) * ADJUSTMENT_SCALE));

  return { adjustmentPoints, sampleSize: outcomeLabels.length, winRate };
}

// `at` bounds the query to scores strictly before the setup being evaluated
// right now -- live always calls this with (effectively) the current time,
// so every existing row already satisfies `time < at` and the bound is a
// no-op there. In replay, `at` is the historical bar being scored, and
// without this bound the query would pull outcomes from setups that (in
// real historical time) haven't happened yet relative to that bar -- a
// classic look-ahead. See .claude/rules/replay-harness.md.
export async function computeHistoricalAdjustment(symbol: string, bucket: string, at: Date): Promise<HistoricalAdjustment> {
  const rows = await prisma.score.findMany({
    where: { strategyVersion: "v3", symbol, v3Bucket: bucket, outcomeLabel: { in: RESOLVED_OUTCOME_LABELS }, time: { lt: at } },
    orderBy: { time: "desc" },
    take: MAX_SIMILAR_SAMPLES,
    select: { outcomeLabel: true },
  });

  return computeAdjustmentFromOutcomes(rows.map((r) => r.outcomeLabel));
}
