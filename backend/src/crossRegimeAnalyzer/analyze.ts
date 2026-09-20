/**
 * Pure aggregation over data Tera Trade already computes -- no new query, no LLM. Scout pitch #6
 * ("auto-flag cross-regime underperformer combos") described the desired signal as regime x
 * priceAction combos that keep losing across sessions; analytics.ts's own
 * computeSessionPerformanceForAllSessions() already breaks every session's scored setups down by
 * marketStructureLabel, liquidityLabel, and priceActionLabel (byMarketStructure/byLiquidity/
 * byPriceAction, each `{ [label]: { sampleSize, resolvedCount, winRate, avgRMultiple } }`) -- this
 * just scans those three per-session breakdowns for labels that clear the sample-size floor but
 * fall below the avgR floor, instead of re-deriving a fresh regime x priceAction cross-product the
 * underlying Score rows don't actually carry as one combined label anyway.
 */
import type { TradingSession } from "../analytics/session.js";
import type { computeSessionPerformanceForAllSessions } from "../api/routes/analytics.js";
import type { BucketDimension, UnderperformerBucket } from "./types.js";

type SessionPerformance = Awaited<ReturnType<typeof computeSessionPerformanceForAllSessions>>;
type SessionStats = SessionPerformance[TradingSession];
type LabelBreakdown = Record<string, { sampleSize: number; resolvedCount: number; winRate: number | null; avgRMultiple: number | null }>;

const DIMENSIONS: { key: "byMarketStructure" | "byLiquidity" | "byPriceAction"; dimension: BucketDimension }[] = [
  { key: "byMarketStructure", dimension: "marketStructure" },
  { key: "byLiquidity", dimension: "liquidity" },
  { key: "byPriceAction", dimension: "priceAction" },
];

export function findUnderperformers(
  sessionPerformance: SessionPerformance,
  opts: { minSampleSize: number; maxAvgR: number }
): UnderperformerBucket[] {
  const flagged: UnderperformerBucket[] = [];

  for (const [session, perf] of Object.entries(sessionPerformance) as [TradingSession, SessionStats][]) {
    for (const { key, dimension } of DIMENSIONS) {
      const breakdown = perf[key] as LabelBreakdown;
      for (const [label, stats] of Object.entries(breakdown)) {
        if (stats.sampleSize < opts.minSampleSize) continue;
        if (stats.avgRMultiple === null || stats.avgRMultiple >= opts.maxAvgR) continue;
        flagged.push({ session, dimension, label, sampleSize: stats.sampleSize, avgRMultiple: stats.avgRMultiple });
      }
    }
  }

  // Worst (most negative) avgR first -- that's the ordering a human reviewing flagged combos
  // actually wants, same "rank by how bad/urgent" posture as scout/ranking.ts's own score.
  return flagged.sort((a, b) => a.avgRMultiple - b.avgRMultiple);
}
