import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";

export async function scoresRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { limit?: string } }>("/api/recommendations", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), 500);
    const rows = await prisma.score.findMany({ orderBy: { time: "desc" }, take: limit });
    return rows.map((s) => ({
      time: s.time,
      symbol: s.symbol,
      strategyId: s.strategyId,
      side: s.side,
      probability: s.probability,
      decision: s.decision,
      explanation: s.explanation,
      tradeId: s.tradeId,
    }));
  });
}
