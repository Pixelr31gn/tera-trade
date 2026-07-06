import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { computeActionability } from "../../scoring/actionability.js";
import { computeInitialStop } from "../../risk/index.js";
import { getInstrument } from "../../marketData/instruments.js";
import type { Score } from "@prisma/client";

// Every score row carries the hypothetical entry/ATR/structure-swing it was
// signaled at (see engine/loop.ts), so the exact stop/target plan can be
// recomputed on demand here -- the same computeInitialStop call the engine
// itself uses -- instead of needing to persist stop/target as their own columns.
function buildTradePlan(score: Score): { entryPrice: number; stopPrice: number; takeProfitPrice: number } {
  const instrument = getInstrument(score.symbol);
  const entryPrice = new Decimal(score.entryPriceAtSignal.toString());
  const atrValue = new Decimal(score.atrAtSignal.toString());
  const structureSwingPrice = score.structureSwingPriceAtSignal ? new Decimal(score.structureSwingPriceAtSignal.toString()) : null;
  const plan = computeInitialStop(entryPrice, score.side as "long" | "short", atrValue, structureSwingPrice, { tickSize: instrument.tickSize });
  return { entryPrice: entryPrice.toNumber(), stopPrice: plan.stopPrice.toNumber(), takeProfitPrice: plan.takeProfitPrice.toNumber() };
}

export async function scoresRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { limit?: string } }>("/api/recommendations", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), 500);
    const rows = await prisma.score.findMany({ orderBy: { time: "desc" }, take: limit });
    return rows.map((s) => ({
      id: s.id,
      time: s.time,
      symbol: s.symbol,
      strategyId: s.strategyId,
      side: s.side,
      probability: s.probability,
      decision: s.decision,
      explanation: s.explanation,
      tradeId: s.tradeId,
      ...buildTradePlan(s),
    }));
  });

  // Setups that cleared the score threshold, aren't yet acted on, and are
  // recent enough to still matter -- one per symbol (the most recent),
  // skipped if there's already an open position in that symbol. This is
  // meant to be read as "you should place this trade," distinct from the
  // full /api/recommendations history table which includes everything
  // taken *and* skipped.
  app.get("/api/recommendations/actionable", async () => {
    const now = new Date();
    const openSymbols = new Set((await prisma.trade.findMany({ where: { status: "open" }, select: { symbol: true } })).map((t) => t.symbol));

    const candidates = await prisma.score.findMany({
      where: { decision: "taken", acknowledged: false },
      orderBy: { time: "desc" },
    });

    const bestPerSymbol = new Map<string, (typeof candidates)[number]>();
    for (const score of candidates) {
      if (openSymbols.has(score.symbol)) continue;
      if (bestPerSymbol.has(score.symbol)) continue; // already have the more recent one (sorted desc)
      const actionability = computeActionability(score.time, now);
      if (actionability === "expired") continue;
      bestPerSymbol.set(score.symbol, score);
    }

    return [...bestPerSymbol.values()].map((s) => ({
      id: s.id,
      time: s.time,
      symbol: s.symbol,
      strategyId: s.strategyId,
      side: s.side,
      probability: s.probability,
      explanation: s.explanation,
      actionability: computeActionability(s.time, now),
      ...buildTradePlan(s),
    }));
  });

  app.post<{ Params: { id: string } }>("/api/recommendations/:id/acknowledge", async (request, reply) => {
    const id = Number(request.params.id);
    const existing = await prisma.score.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Recommendation not found" });
    await prisma.score.update({ where: { id }, data: { acknowledged: true, acknowledgedAt: new Date() } });
    return { status: "acknowledged" };
  });
}
