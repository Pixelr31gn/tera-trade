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

const cache = new Map<string, { stats: FixedTargetEdgeStats; computedAt: number }>();

async function loadBarsAfter(symbol: string, after: Date, limit: number): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({ where: { symbol, time: { gt: after } }, orderBy: { time: "asc" }, take: limit });
  return rows.map((r) => ({ time: r.time, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

async function computeFixedTargetEdge(symbol: string, session: TradingSession, side: "long" | "short"): Promise<FixedTargetEdgeStats> {
  // A symbol outside the static instrument list (e.g. a synthetic test
  // fixture) has no known tick size to compute a stop plan against --
  // report "no evidence yet" rather than crashing the whole engine loop.
  let instrument;
  try {
    instrument = getInstrument(symbol);
  } catch {
    return summarizeFixedTargetOutcomes([]);
  }

  const scores = await prisma.score.findMany({ where: { symbol, session, side } });

  const labels: OutcomeLabel[] = [];
  for (const score of scores) {
    const bars = await loadBarsAfter(symbol, score.time, MAX_BARS_TO_WALK);
    if (bars.length < MIN_BARS_TO_JUDGE) continue;

    const entryPrice = new Decimal(score.entryPriceAtSignal.toString());
    const atrValue = new Decimal(score.atrAtSignal.toString());
    const structureSwingPrice = score.structureSwingPriceAtSignal ? new Decimal(score.structureSwingPriceAtSignal.toString()) : null;
    const stopPlan = computeInitialStop(entryPrice, side, atrValue, structureSwingPrice, { tickSize: instrument.tickSize });
    const targetPrice = side === "long" ? entryPrice.plus(LONG_TARGET_POINTS) : entryPrice.minus(LONG_TARGET_POINTS);

    const outcome = evaluateHypotheticalOutcome(side, entryPrice.toNumber(), stopPlan.stopPrice.toNumber(), targetPrice.toNumber(), bars);
    labels.push(outcome.label);
  }

  return summarizeFixedTargetOutcomes(labels);
}

export async function getFixedTargetEdge(symbol: string, session: TradingSession, side: "long" | "short"): Promise<FixedTargetEdgeStats> {
  const key = `${symbol}:${session}:${side}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.stats;

  const stats = await computeFixedTargetEdge(symbol, session, side);
  cache.set(key, { stats, computedAt: Date.now() });
  return stats;
}

/** Test-only: clear the cache so tests don't see another test's stale state. */
export function _resetFixedTargetEdgeCacheForTests(): void {
  cache.clear();
}
