/**
 * Empirical probability that a setup in a given (symbol, session, side)
 * bucket reaches a fixed point target before its risk-managed stop --
 * computed from every historical Score in that bucket with enough
 * subsequent bars to judge, using the exact same stop plan and
 * win/loss/no_resolution simulation as engine/outcomeEvaluator.ts, just
 * against LONG_TARGET_POINTS instead of the original ATR/2R target.
 *
 * This is the actual, continuously-updated evidence behind "only take a long
 * if there's a 67%+ historical chance of a 20-point move" (scoring/gate.ts) --
 * not an assumption. Re-evaluating real session data initially showed this
 * bar is not cleared almost anywhere yet (best case ~16% for NQ), so this
 * gate is expected to block most/all long setups until real evidence changes
 * that.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { summarizeFixedTargetOutcomes, type FixedTargetEdgeStats } from "../analytics/fixedTargetEdge.js";
import { evaluateHypotheticalOutcome, type OutcomeLabel } from "../analytics/outcomeSimulation.js";
import type { TradingSession } from "../analytics/session.js";
import { getInstrument } from "../marketData/instruments.js";
import { computeInitialStop } from "../risk/index.js";
import type { OhlcBar } from "../regime/indicators.js";

export const LONG_TARGET_POINTS = 20;
export const MIN_LONG_TARGET_SAMPLE_SIZE = 30;
export const MIN_LONG_TARGET_WIN_RATE = 0.67;

const CACHE_TTL_MS = 60 * 60 * 1000; // this stat moves slowly -- no need to recompute every tick
const MAX_BARS_TO_WALK = 500;
const MIN_BARS_TO_JUDGE = 50;
// The scores query below used to be unbounded, and each matching row fires
// its own separate loadBarsAfter query -- a classic N+1: with the Score
// table now carrying v1/v2/v3 shadow-scoring (3x the rows) plus the
// continuous scan, a single (symbol, session, side) bucket could match
// thousands of rows, each triggering its own round-trip. Capped to the most
// recent 300 -- already a generous sample for an empirical win rate, well
// above MIN_LONG_TARGET_SAMPLE_SIZE (30).
const MAX_SCORES_TO_EVALUATE = 300;

const cache = new Map<string, { stats: FixedTargetEdgeStats; computedAt: number }>();

async function loadBarsAfter(symbol: string, after: Date, limit: number): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({ where: { symbol, time: { gt: after } }, orderBy: { time: "asc" }, take: limit });
  return rows.map((r) => ({ time: r.time, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

// Exported for ReplayDecisionContext: replay must NOT go through
// getFixedTargetEdge's cache below, which is keyed only by (symbol, session,
// side) and TTLed against wall-clock time -- a later, cache-hit call for an
// earlier historical `at` would silently return a different bar's result.
// This is the uncached core; replay calls it directly every time.
export async function computeFixedTargetEdge(symbol: string, session: TradingSession, side: "long" | "short", at: Date): Promise<FixedTargetEdgeStats> {
  // A symbol outside the static instrument list (e.g. a synthetic test
  // fixture) has no known tick size to compute a stop plan against --
  // report "no evidence yet" rather than crashing the whole engine loop.
  let instrument;
  try {
    instrument = getInstrument(symbol);
  } catch {
    return summarizeFixedTargetOutcomes([]);
  }

  // `time: { lt: at }` bounds this to scores from before the setup being
  // evaluated right now -- live always calls with (effectively) the current
  // time, so this is a no-op there; in replay, `at` is the historical bar
  // being scored, and without the bound this would read outcomes from setups
  // that (in real historical time) haven't happened yet. See
  // .claude/rules/replay-harness.md.
  const scores = await prisma.score.findMany({ where: { symbol, session, side, time: { lt: at } }, orderBy: { time: "desc" }, take: MAX_SCORES_TO_EVALUATE });

  // Still fundamentally one loadBarsAfter query per score (each needs a
  // different bar window), but run with bounded concurrency instead of one
  // at a time -- measured at 24s sequential for ~230 scores; the earlier
  // parallelize-everything attempt elsewhere this session caused Neon pool
  // contention when many *different* endpoints fired dozens of concurrent
  // queries each, so this caps concurrency rather than firing all 300 at once.
  const CONCURRENCY = 15;
  const labels: OutcomeLabel[] = [];
  for (let i = 0; i < scores.length; i += CONCURRENCY) {
    const batch = scores.slice(i, i + CONCURRENCY);
    const batchOutcomes = await Promise.all(
      batch.map(async (score) => {
        const bars = await loadBarsAfter(symbol, score.time, MAX_BARS_TO_WALK);
        if (bars.length < MIN_BARS_TO_JUDGE) return null;

        const entryPrice = new Decimal(score.entryPriceAtSignal.toString());
        const atrValue = new Decimal(score.atrAtSignal.toString());
        const structureSwingPrice = score.structureSwingPriceAtSignal ? new Decimal(score.structureSwingPriceAtSignal.toString()) : null;
        const stopPlan = computeInitialStop(entryPrice, side, atrValue, structureSwingPrice, { tickSize: instrument.tickSize });
        const targetPrice = side === "long" ? entryPrice.plus(LONG_TARGET_POINTS) : entryPrice.minus(LONG_TARGET_POINTS);

        return evaluateHypotheticalOutcome(side, entryPrice.toNumber(), stopPlan.stopPrice.toNumber(), targetPrice.toNumber(), bars).label;
      })
    );
    for (const label of batchOutcomes) if (label !== null) labels.push(label);
  }

  return summarizeFixedTargetOutcomes(labels);
}

// `at` is the caller's as-of time (see decisionCore.ts). Live and replay both
// pass it explicitly now; live's own TTL cache below still keys purely off
// (symbol, session, side) and ignores `at` for cache-hit purposes -- callers
// only ever call this "now," so the cache's existing wall-clock TTL already
// does the right thing there, unchanged by this parameter's addition.
export async function getFixedTargetEdge(symbol: string, session: TradingSession, side: "long" | "short", at: Date): Promise<FixedTargetEdgeStats> {
  const key = `${symbol}:${session}:${side}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.stats;

  const stats = await computeFixedTargetEdge(symbol, session, side, at);
  cache.set(key, { stats, computedAt: Date.now() });
  return stats;
}
