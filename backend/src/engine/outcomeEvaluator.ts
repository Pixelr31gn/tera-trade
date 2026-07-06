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

async function evaluateSkippedScores(): Promise<number> {
  const pending = await prisma.score.findMany({
    where: { outcomeLabel: null, tradeId: null },
  });

  let updated = 0;
  for (const score of pending) {
    const bars = await loadBarsAfter(score.symbol, score.time, MAX_BARS_TO_WALK);
    if (bars.length < MIN_BARS_TO_JUDGE) continue; // too soon to judge -- leave pending

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
    updated++;
  }
  return updated;
}

export async function evaluatePendingOutcomes(): Promise<{ taken: number; skipped: number }> {
  const taken = await evaluateTakenScores();
  const skipped = await evaluateSkippedScores();
  if (taken || skipped) logger.info({ taken, skipped }, "outcomes_evaluated");
  return { taken, skipped };
}
