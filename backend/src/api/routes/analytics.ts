import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getOpeningRangeStats } from "../../engine/openingRangeCache.js";
import { DEFAULT_INSTRUMENTS } from "../../marketData/instruments.js";
import { TradingSession } from "../../analytics/session.js";
import { MLScorer, MIN_TRAINING_ROWS_PER_SESSION } from "../../scoring/training.js";

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { symbol?: string } }>("/api/analytics/opening-range", async (request) => {
    const symbols = request.query.symbol ? [request.query.symbol] : DEFAULT_INSTRUMENTS.map((i) => i.symbol);
    const results: Record<string, Awaited<ReturnType<typeof getOpeningRangeStats>>> = {};
    for (const symbol of symbols) {
      results[symbol] = await getOpeningRangeStats(symbol);
    }
    return results;
  });

  // Per-session dataset breakdown -- New York/London/Asian are never merged
  // (see analytics/session.ts), so this is the surface for judging how
  // "concrete" each session's adaptive model actually is: sample size, win
  // rate among resolved setups, and which descriptive confluence labels
  // actually performed well within that session.
  app.get("/api/analytics/session-performance", async () => {
    const sessions: TradingSession[] = [TradingSession.NEW_YORK, TradingSession.LONDON, TradingSession.ASIAN];
    const results: Record<string, Awaited<ReturnType<typeof computeSessionPerformance>>> = {};
    for (const session of sessions) {
      results[session] = await computeSessionPerformance(session);
    }
    return results;
  });
}

const POSITIVE_OUTCOME_LABELS = new Set(["executed_win", "missed_win"]);
const NEGATIVE_OUTCOME_LABELS = new Set(["executed_loss", "missed_loss"]);

function labelBreakdown(rows: { label: string; outcomeLabel: string | null; rMultiple: number | null }[]) {
  const buckets = new Map<string, { total: number; wins: number; losses: number; rSum: number; rCount: number }>();
  for (const row of rows) {
    const bucket = buckets.get(row.label) ?? { total: 0, wins: 0, losses: 0, rSum: 0, rCount: 0 };
    bucket.total++;
    if (row.outcomeLabel && POSITIVE_OUTCOME_LABELS.has(row.outcomeLabel)) bucket.wins++;
    if (row.outcomeLabel && NEGATIVE_OUTCOME_LABELS.has(row.outcomeLabel)) bucket.losses++;
    if (row.rMultiple !== null) {
      bucket.rSum += row.rMultiple;
      bucket.rCount++;
    }
    buckets.set(row.label, bucket);
  }
  return Object.fromEntries(
    [...buckets.entries()].map(([label, b]) => [
      label,
      {
        sampleSize: b.total,
        resolvedCount: b.wins + b.losses,
        winRate: b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : null,
        avgRMultiple: b.rCount > 0 ? b.rSum / b.rCount : null,
      },
    ])
  );
}

async function computeSessionPerformance(session: TradingSession) {
  const rows = await prisma.score.findMany({
    where: { session },
    select: { outcomeLabel: true, outcomeRMultiple: true, features: true },
  });

  const outcomeCounts: Record<string, number> = {};
  let wins = 0;
  let losses = 0;
  let rSum = 0;
  let rCount = 0;
  const marketStructureRows: { label: string; outcomeLabel: string | null; rMultiple: number | null }[] = [];
  const liquidityRows: { label: string; outcomeLabel: string | null; rMultiple: number | null }[] = [];
  const priceActionRows: { label: string; outcomeLabel: string | null; rMultiple: number | null }[] = [];

  for (const row of rows) {
    const key = row.outcomeLabel ?? "pending";
    outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;

    const rMultiple = row.outcomeRMultiple !== null ? Number(row.outcomeRMultiple) : null;
    if (row.outcomeLabel && POSITIVE_OUTCOME_LABELS.has(row.outcomeLabel)) wins++;
    if (row.outcomeLabel && NEGATIVE_OUTCOME_LABELS.has(row.outcomeLabel)) losses++;
    if (rMultiple !== null) {
      rSum += rMultiple;
      rCount++;
    }

    const features = row.features as Record<string, unknown>;
    if (typeof features.marketStructureLabel === "string") marketStructureRows.push({ label: features.marketStructureLabel, outcomeLabel: row.outcomeLabel, rMultiple });
    if (typeof features.liquidityLabel === "string") liquidityRows.push({ label: features.liquidityLabel, outcomeLabel: row.outcomeLabel, rMultiple });
    if (typeof features.priceActionLabel === "string") priceActionRows.push({ label: features.priceActionLabel, outcomeLabel: row.outcomeLabel, rMultiple });
  }

  const resolvedCount = wins + losses;

  return {
    session,
    totalScores: rows.length,
    outcomeCounts,
    resolvedCount,
    winRate: resolvedCount > 0 ? wins / resolvedCount : null,
    avgRMultiple: rCount > 0 ? rSum / rCount : null,
    modelTrained: MLScorer.isAvailable(session),
    minRowsRequiredForModel: MIN_TRAINING_ROWS_PER_SESSION,
    byMarketStructure: labelBreakdown(marketStructureRows),
    byLiquidity: labelBreakdown(liquidityRows),
    byPriceAction: labelBreakdown(priceActionRows),
  };
}
