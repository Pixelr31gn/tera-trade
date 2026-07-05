import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";

export async function tradesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { status?: string; symbol?: string; limit?: string } }>("/api/trades", async (request) => {
    const { status, symbol } = request.query;
    const limit = Math.min(Number(request.query.limit ?? 200), 1000);
    const rows = await prisma.trade.findMany({
      where: { ...(status ? { status } : {}), ...(symbol ? { symbol } : {}) },
      orderBy: { entryTime: "desc" },
      take: limit,
    });
    return rows.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      strategyId: t.strategyId,
      side: t.side,
      quantity: t.quantity,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      exitPrice: t.exitPrice,
      exitReason: t.exitReason,
      pnl: t.pnl,
      mae: t.mae,
      mfe: t.mfe,
      score: t.score,
      regimeTrendAtEntry: t.regimeTrendAtEntry,
      regimeVolAtEntry: t.regimeVolAtEntry,
      status: t.status,
      explanation: t.explanation,
    }));
  });
}
