/**
 * Retrospectively labels every scored setup with what actually happened --
 * this is the core of the "trade tracking and machine learning feedback"
 * dataset: every recommendation (taken or skipped) eventually gets an
 * outcome, not just the ones that turned into real trades.
 *
 * - "taken" setups: labeled directly from the linked Trade once it closes.
 * - skipped/blocked setups: labeled by simulating forward from the
 *   hypothetical entry/stop/target captured at signal time (see
 *   engine/loop.ts) against the bars that actually followed.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { evaluateHypotheticalOutcome } from "../analytics/outcomeSimulation.js";
import { getInstrument } from "../marketData/instruments.js";
import { computeInitialStop } from "../risk/index.js";
import type { OhlcBar } from "../regime/indicators.js";

const logger = childLogger("outcomeEvaluator");

// Below this many bars since the signal, it's genuinely too soon to judge --
// leave it pending rather than guess. Above this many, if still unresolved,
// call it (see analytics/outcomeSimulation.ts's "no_resolution" case).
const MIN_BARS_TO_JUDGE = 50;
const MAX_BARS_TO_WALK = 500;
// Bounds a single pass regardless of how large the pending backlog gets (e.g.
// after extended downtime) -- oldest-first, so a big backlog just drains over
// subsequent 5-minute ticks instead of one tick doing unbounded work.
const MAX_ROWS_PER_PASS = 200;
// Same bounded-concurrency shape as engine/fixedTargetEdgeCache.ts's identical
// per-row loadBarsAfter-per-row pattern (tuned there against real Neon pool
// contention) -- each pending row needs its own bar-window fetch, so this
// batches that fan-out instead of firing all of them (or none of them) at once.
const CONCURRENCY = 15;

async function loadBarsAfter(symbol: string, after: Date, limit: number): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({
    where: { symbol, time: { gt: after } },
    orderBy: { time: "asc" },
    take: limit,
  });
  return rows.map((r) => ({ time: r.time, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

async function evaluateTakenScores(): Promise<number> {
  const pending = await prisma.score.findMany({
    where: { outcomeLabel: null, decision: "taken", tradeId: { not: null } },
    include: { trade: true },
    orderBy: { time: "asc" },
    take: MAX_ROWS_PER_PASS,
  });

  let updated = 0;
  for (const score of pending) {
    const trade = score.trade;
    if (!trade || trade.status !== "closed" || trade.pnl === null) continue;

    const pnl = Number(trade.pnl);
    const entryPrice = Number(trade.entryPrice);
    const stopDistance = Math.abs(entryPrice - Number(trade.stopPrice));
    const instrument = getInstrument(score.symbol);
    const riskAmountPerContract = stopDistance * Number(instrument.pointValue) * trade.quantity;
    const rMultiple = riskAmountPerContract > 0 ? pnl / riskAmountPerContract : 0;

    await prisma.score.update({
      where: { id: score.id },
      data: {
        outcomeLabel: pnl > 0 ? "executed_win" : "executed_loss",
        outcomeRMultiple: rMultiple.toString(),
        outcomeEvaluatedAt: new Date(),
      },
    });
    updated++;
  }
  return updated;
}

// Extracted so a one-off backfill script (e.g. catching up a strategy
// version's whole backlog outside the live per-tick pacing) can reuse the
// exact same simulation logic instead of duplicating it.
export async function evaluateSkippedScoreRow(score: {
  id: number;
  symbol: string;
  time: Date;
  entryPriceAtSignal: { toString(): string };
  atrAtSignal: { toString(): string };
  structureSwingPriceAtSignal: { toString(): string } | null;
  side: string;
}): Promise<boolean> {
  const bars = await loadBarsAfter(score.symbol, score.time, MAX_BARS_TO_WALK);
  if (bars.length < MIN_BARS_TO_JUDGE) return false; // too soon to judge -- leave pending

  const instrument = getInstrument(score.symbol);
  const entryPrice = new Decimal(score.entryPriceAtSignal.toString());
  const atrValue = new Decimal(score.atrAtSignal.toString());
  const structureSwingPrice = score.structureSwingPriceAtSignal ? new Decimal(score.structureSwingPriceAtSignal.toString()) : null;
  const side = score.side as "long" | "short";

  // Recompute the same hypothetical stop plan engine/loop.ts computed at
  // signal time -- computeInitialStop is pure, so this reproduces the
  // identical stop/target rather than needing to have stored them redundantly.
  const stopPlan = computeInitialStop(entryPrice, side, atrValue, structureSwingPrice, { tickSize: instrument.tickSize });

  const outcome = evaluateHypotheticalOutcome(side, entryPrice.toNumber(), stopPlan.stopPrice.toNumber(), stopPlan.takeProfitPrice.toNumber(), bars);

  const outcomeLabel = outcome.label === "win" ? "missed_win" : outcome.label === "loss" ? "missed_loss" : "no_resolution";

  await prisma.score.update({
    where: { id: score.id },
    data: {
      outcomeLabel,
      outcomeRMultiple: outcome.rMultiple.toString(),
      outcomeEvaluatedAt: new Date(),
    },
  });
  return true;
}

async function evaluateSkippedScores(): Promise<number> {
  // A single global-oldest-first query starves any strategy version whose
  // backlog started more recently than another version's: with inflow
  // consistently outpacing MAX_ROWS_PER_PASS per tick, older versions' rows
  // never fully drain, so a plain `take: MAX_ROWS_PER_PASS` here would keep
  // picking exclusively from whichever version has been running longest --
  // confirmed live 2026-07-29, where v5 (scoring only since 2026-07-21) had
  // zero rows ever resolved because v1/v2/v3's much older backlog (since
  // 2026-07-10) always filled the entire budget first. Give every version
  // with pending rows its own fair slice of the pass budget instead, so a
  // newer/smaller backlog always makes forward progress regardless of how
  // deep an older version's backlog is.
  const pendingVersions = await prisma.score.groupBy({
    by: ["strategyVersion"],
    where: { outcomeLabel: null, tradeId: null },
  });
  if (pendingVersions.length === 0) return 0;

  const perVersionCap = Math.max(1, Math.floor(MAX_ROWS_PER_PASS / pendingVersions.length));
  const perVersionBatches = await Promise.all(
    pendingVersions.map((v) =>
      prisma.score.findMany({
        where: { outcomeLabel: null, tradeId: null, strategyVersion: v.strategyVersion },
        orderBy: { time: "asc" },
        take: perVersionCap,
      })
    )
  );
  const pending = perVersionBatches.flat();

  let updated = 0;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(evaluateSkippedScoreRow));
    updated += results.filter(Boolean).length;
  }
  return updated;
}

export async function evaluatePendingOutcomes(): Promise<{ taken: number; skipped: number }> {
  const taken = await evaluateTakenScores();
  const skipped = await evaluateSkippedScores();
  if (taken || skipped) logger.info({ taken, skipped }, "outcomes_evaluated");
  return { taken, skipped };
}
