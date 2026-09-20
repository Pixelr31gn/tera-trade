import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getOpeningRangeStats } from "../../engine/openingRangeCache.js";
import { DEFAULT_INSTRUMENTS } from "../../marketData/instruments.js";
import { TradingSession } from "../../analytics/session.js";
import { MLScorer, MIN_TRAINING_ROWS_PER_SESSION } from "../../scoring/training.js";

// Both session-performance and version-divergence scan every Score row in
// the window -- unbounded, that scan (and the response) only ever gets
// bigger and slower as the table grows, since scoring now runs for v1/v2/v3
// on every signal. 30 days is far more than enough to judge "recent"
// performance and keeps these endpoints from silently degrading over time.
const ANALYTICS_LOOKBACK_DAYS = 30;
function analyticsLookbackSince(): Date {
  return new Date(Date.now() - ANALYTICS_LOOKBACK_DAYS * 86_400_000);
}

// These three summarize historical performance, not live trading state --
// nothing about a session's win rate or a strategy version's edge actually
// changes tick to tick. Re-scanning the whole (unbounded, ever-growing)
// Score table on every request -- previously happening every 30s from two
// pages at once for session-performance alone -- was pure waste. A 24h TTL
// still refreshes daily while cutting that DB load to near zero.
const ANALYTICS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const analyticsCache = new Map<string, { value: unknown; computedAt: number }>();
export async function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = analyticsCache.get(key);
  if (hit && Date.now() - hit.computedAt < ANALYTICS_CACHE_TTL_MS) return hit.value as T;
  const value = await compute();
  analyticsCache.set(key, { value, computedAt: Date.now() });
  return value;
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { symbol?: string } }>("/api/analytics/opening-range", async (request) => {
    const symbols = request.query.symbol ? [request.query.symbol] : DEFAULT_INSTRUMENTS.map((i) => i.symbol);
    // These are independent per-symbol lookups -- running them sequentially
    // just sums up N remote round-trips for no reason. Same fix applied
    // throughout this file (see session-performance/strategy-comparison
    // below), which were measured at 19.6s and 15.7s respectively before
    // parallelizing -- almost entirely time spent waiting on Neon
    // round-trips one at a time instead of concurrently.
    const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await getOpeningRangeStats(symbol)] as const));
    return Object.fromEntries(entries);
  });

  // Per-session dataset breakdown -- New York/London/Asian are never merged
  // (see analytics/session.ts), so this is the surface for judging how
  // "concrete" each session's adaptive model actually is: sample size, win
  // rate among resolved setups, and which descriptive confluence labels
  // actually performed well within that session.
  app.get("/api/analytics/session-performance", async () => {
    return cached("session-performance", () => computeSessionPerformanceForAllSessions());
  });

  // v1 vs v2 vs v3 side-by-side, per session -- all three versions are
  // shadow-scored on every signal (see engine/loop.ts), so this is a true
  // apples-to-apples comparison over the exact same market conditions, not
  // different time periods. Used to decide when/whether to actually switch
  // the active version.
  app.get("/api/analytics/strategy-comparison", async () => {
    return cached("strategy-comparison", () => computeStrategyComparison());
  });

  // The aggregate win rate in strategy-comparison above is misleading on its
  // own: v1/v2/v3 shadow-score the exact same underlying signal, and for any
  // signal where they *agree* on taken/skipped, a skipped setup's outcome is
  // a retrospective simulation of the same hypothetical trade regardless of
  // which version scored it -- identical outcome, not independent evidence.
  // The only real evidence of "is this version's judgment better" is in the
  // signals where they *disagree*: one version's extra factors pushed it
  // over the threshold the other one didn't clear. This joins scores for the
  // same (time, symbol, strategyId) across version pairs and reports how
  // each version's incremental (disagreement-only) picks actually resolved.
  app.get("/api/analytics/version-divergence", async () => {
    return cached("version-divergence", () => computeVersionDivergence());
  });

  // Strategies (breakout/mean-reversion/trend-following/trend-pullback-fib)
  // aren't scoring versions -- they don't have a comparable win-rate/avg-R
  // read the way v1-v5 do, since they're the signal SOURCE v1-v5 grade, not
  // a grader themselves. This answers the more basic "is it alive" question
  // instead: how many times has this strategyId actually fired a signal, and
  // when was the last one. Deliberately uncached (unlike the three endpoints
  // above) -- this is meant to answer "is it alive right now," and a 24h-old
  // answer to that question defeats the point.
  app.get<{ Querystring: { strategyId: string } }>("/api/analytics/strategy-status", async (request, reply) => {
    const { strategyId } = request.query;
    if (!strategyId) return reply.code(400).send({ error: "strategyId is required" });
    return computeStrategyStatus(strategyId);
  });
}

const OUTCOME_POSITIVE = new Set(["executed_win", "missed_win"]);
const OUTCOME_NEGATIVE = new Set(["executed_loss", "missed_loss"]);

interface DivergenceBucket {
  n: number;
  win: number;
  loss: number;
  pending: number;
  winRate: number | null;
}

function emptyBucket(): DivergenceBucket {
  return { n: 0, win: 0, loss: 0, pending: 0, winRate: null };
}

export async function computeVersionDivergence() {
  // v2 stopped receiving new scores 2026-07-14 but stays in this comparison
  // -- its historical rows are still there and still worth being able to
  // recall/compare against, per the reason it's kept in the DB at all.
  const versions = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"] as const;
  const rows = await prisma.score.findMany({
    where: { strategyVersion: { in: [...versions] }, time: { gte: analyticsLookbackSince() } },
    select: { time: true, symbol: true, strategyId: true, strategyVersion: true, decision: true, outcomeLabel: true },
  });

  const byKey = new Map<string, Partial<Record<(typeof versions)[number], (typeof rows)[number]>>>();
  for (const row of rows) {
    const key = `${row.time.toISOString()}|${row.symbol}|${row.strategyId}`;
    const entry = byKey.get(key) ?? {};
    entry[row.strategyVersion as (typeof versions)[number]] = row;
    byKey.set(key, entry);
  }

  function addOutcome(bucket: DivergenceBucket, outcomeLabel: string | null): void {
    bucket.n++;
    if (outcomeLabel && OUTCOME_POSITIVE.has(outcomeLabel)) bucket.win++;
    else if (outcomeLabel && OUTCOME_NEGATIVE.has(outcomeLabel)) bucket.loss++;
    else bucket.pending++;
  }

  function finalize(bucket: DivergenceBucket): DivergenceBucket {
    const resolved = bucket.win + bucket.loss;
    bucket.winRate = resolved > 0 ? bucket.win / resolved : null;
    return bucket;
  }

  const results: Record<string, { onlyATook: DivergenceBucket; onlyBTook: DivergenceBucket; agreedPairs: number }> = {};

  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      const a = versions[i]!;
      const b = versions[j]!;
      const onlyATook = emptyBucket();
      const onlyBTook = emptyBucket();
      let agreedPairs = 0;

      for (const entry of byKey.values()) {
        const scoreA = entry[a];
        const scoreB = entry[b];
        if (!scoreA || !scoreB) continue;
        const aTook = scoreA.decision === "taken";
        const bTook = scoreB.decision === "taken";
        if (aTook && !bTook) addOutcome(onlyATook, scoreA.outcomeLabel);
        else if (bTook && !aTook) addOutcome(onlyBTook, scoreB.outcomeLabel);
        else agreedPairs++;
      }

      results[`${a}_vs_${b}`] = { onlyATook: finalize(onlyATook), onlyBTook: finalize(onlyBTook), agreedPairs };
    }
  }

  return results;
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

type SessionScoreRow = {
  outcomeLabel: string | null;
  outcomeRMultiple: unknown;
  marketStructureLabel: string | null;
  liquidityLabel: string | null;
  priceActionLabel: string | null;
  decision?: string;
};

// Pure aggregation, no DB access -- lets callers fetch once (across every
// session, and every version where relevant) and group in memory instead of
// firing one query per session/version combination. Firing N queries in
// parallel still means N connections competing for the same limited Neon
// pool at once; one broader query and an in-process group-by is both fewer
// round trips and lower peak connection pressure.
function summarizeSessionScores(session: TradingSession, rows: SessionScoreRow[]) {
  const outcomeCounts: Record<string, number> = {};
  let wins = 0;
  let losses = 0;
  let rSum = 0;
  let rCount = 0;
  // "Taken-only" mirrors the blended wins/losses/rSum/rCount above but
  // restricted to decision === "taken" -- see this function's own comment
  // below for why the blended figures can't actually distinguish one
  // version's judgment from another's, and why this narrower slice can.
  let takenWins = 0;
  let takenLosses = 0;
  let takenRSum = 0;
  let takenRCount = 0;
  const marketStructureRows: { label: string; outcomeLabel: string | null; rMultiple: number | null }[] = [];
  const liquidityRows: { label: string; outcomeLabel: string | null; rMultiple: number | null }[] = [];
  const priceActionRows: { label: string; outcomeLabel: string | null; rMultiple: number | null }[] = [];

  for (const row of rows) {
    const key = row.outcomeLabel ?? "pending";
    outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;

    const rMultiple = row.outcomeRMultiple !== null ? Number(row.outcomeRMultiple) : null;
    const isWin = row.outcomeLabel !== null && POSITIVE_OUTCOME_LABELS.has(row.outcomeLabel);
    const isLoss = row.outcomeLabel !== null && NEGATIVE_OUTCOME_LABELS.has(row.outcomeLabel);
    if (isWin) wins++;
    if (isLoss) losses++;
    if (rMultiple !== null) {
      rSum += rMultiple;
      rCount++;
    }
    if (row.decision === "taken") {
      if (isWin) takenWins++;
      if (isLoss) takenLosses++;
      if (rMultiple !== null) {
        takenRSum += rMultiple;
        takenRCount++;
      }
    }

    if (row.marketStructureLabel !== null) marketStructureRows.push({ label: row.marketStructureLabel, outcomeLabel: row.outcomeLabel, rMultiple });
    if (row.liquidityLabel !== null) liquidityRows.push({ label: row.liquidityLabel, outcomeLabel: row.outcomeLabel, rMultiple });
    if (row.priceActionLabel !== null) priceActionRows.push({ label: row.priceActionLabel, outcomeLabel: row.outcomeLabel, rMultiple });
  }

  const resolvedCount = wins + losses;
  const takenResolvedCount = takenWins + takenLosses;

  return {
    session,
    totalScores: rows.length,
    outcomeCounts,
    resolvedCount,
    // Blended across every scored setup regardless of whether THIS version
    // said "taken" or "skipped" -- see engine/outcomeEvaluator.ts:
    // computeInitialStop (the hypothetical stop/target used to grade a
    // skipped setup) takes only side/entryPrice/atr/structureSwing, none of
    // which vary by scoring version, so a skipped setup grades identically
    // no matter which version's row it's attached to. That makes this
    // number converge across v1..v7 almost regardless of real judgment
    // quality -- it answers "how did the underlying signals do," not "how
    // good is this version." Kept for backward compatibility (session
    // dashboard, ML-training-readiness gate); use takenWinRate below to
    // actually compare versions. Root-caused 2026-09-03 after the Strategy
    // Comparison page showed all six versions within ~2 points of each
    // other.
    winRate: resolvedCount > 0 ? wins / resolvedCount : null,
    avgRMultiple: rCount > 0 ? rSum / rCount : null,
    // Restricted to this version's own decision === "taken" rows -- the
    // actual population where different versions' judgment diverges (they
    // don't all take the same signals), so this is the metric that answers
    // "how does this version's own judgment actually perform."
    takenCount: rows.filter((r) => r.decision === "taken").length,
    takenResolvedCount,
    takenWinRate: takenResolvedCount > 0 ? takenWins / takenResolvedCount : null,
    takenAvgRMultiple: takenRCount > 0 ? takenRSum / takenRCount : null,
    modelTrained: MLScorer.isAvailable(session),
    minRowsRequiredForModel: MIN_TRAINING_ROWS_PER_SESSION,
    byMarketStructure: labelBreakdown(marketStructureRows),
    byLiquidity: labelBreakdown(liquidityRows),
    byPriceAction: labelBreakdown(priceActionRows),
  };
}

const ALL_SESSIONS: TradingSession[] = [TradingSession.NEW_YORK, TradingSession.LONDON, TradingSession.ASIAN];

/** One query for every session (optionally scoped to one strategy version), grouped in memory -- see summarizeSessionScores's comment for why this replaces N per-session round trips. */
export async function computeSessionPerformanceForAllSessions(strategyVersion?: "v1" | "v2" | "v3" | "v4" | "v5" | "v6"): Promise<Record<TradingSession, ReturnType<typeof summarizeSessionScores>>> {
  const rows = await prisma.score.findMany({
    where: { time: { gte: analyticsLookbackSince() }, ...(strategyVersion ? { strategyVersion } : {}) },
    select: { session: true, outcomeLabel: true, outcomeRMultiple: true, marketStructureLabel: true, liquidityLabel: true, priceActionLabel: true },
  });

  const bySession = new Map<string, SessionScoreRow[]>();
  for (const row of rows) {
    const list = bySession.get(row.session) ?? [];
    list.push(row);
    bySession.set(row.session, list);
  }

  const results = {} as Record<TradingSession, ReturnType<typeof summarizeSessionScores>>;
  for (const session of ALL_SESSIONS) results[session] = summarizeSessionScores(session, bySession.get(session) ?? []);
  return results;
}

/**
 * One Score row exists per (signal, scoring version) -- a single fired
 * signal produces 4 rows (v1/v2/v3/v5), all sharing the same (time, symbol).
 * Grouping by that pair before counting is what turns "row count" into
 * "actual signal count" -- without it this would overcount fires by ~4x.
 */
export async function computeStrategyStatus(strategyId: string): Promise<{
  strategyId: string;
  fireCount: number;
  lastFiredAt: string | null;
  takenCount: number;
}> {
  const rows = await prisma.score.findMany({
    where: { strategyId },
    select: { time: true, symbol: true, decision: true },
    orderBy: { time: "desc" },
  });

  const bySignal = new Map<string, { time: Date; taken: boolean }>();
  for (const row of rows) {
    const key = `${row.time.toISOString()}|${row.symbol}`;
    const existing = bySignal.get(key);
    // "taken" if ANY version's row for this signal reached that decision --
    // matches how determineConsensus itself treats a signal (any qualifying
    // version is enough), not literal row-level unanimity.
    bySignal.set(key, { time: row.time, taken: existing?.taken || row.decision === "taken" });
  }

  const signals = [...bySignal.values()];
  return {
    strategyId,
    fireCount: signals.length,
    lastFiredAt: signals.length > 0 ? signals.reduce((latest, s) => (s.time > latest ? s.time : latest), signals[0]!.time).toISOString() : null,
    takenCount: signals.filter((s) => s.taken).length,
  };
}

/** One query covering every (version, session) combination, grouped in memory -- replaces what was 9 separate round trips. */
export async function computeStrategyComparison(): Promise<Record<"v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7", Record<TradingSession, ReturnType<typeof summarizeSessionScores>>>> {
  const versions = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"] as const;
  const rows = await prisma.score.findMany({
    where: { time: { gte: analyticsLookbackSince() }, strategyVersion: { in: [...versions] } },
    select: { session: true, strategyVersion: true, outcomeLabel: true, outcomeRMultiple: true, marketStructureLabel: true, liquidityLabel: true, priceActionLabel: true, decision: true },
  });

  const byVersionSession = new Map<string, SessionScoreRow[]>();
  for (const row of rows) {
    const key = `${row.strategyVersion}|${row.session}`;
    const list = byVersionSession.get(key) ?? [];
    list.push(row);
    byVersionSession.set(key, list);
  }

  const results = {} as Record<"v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7", Record<TradingSession, ReturnType<typeof summarizeSessionScores>>>;
  for (const version of versions) {
    results[version] = {} as Record<TradingSession, ReturnType<typeof summarizeSessionScores>>;
    for (const session of ALL_SESSIONS) {
      results[version][session] = summarizeSessionScores(session, byVersionSession.get(`${version}|${session}`) ?? []);
    }
  }
  return results;
}
