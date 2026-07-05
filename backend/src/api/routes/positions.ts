import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";

export async function positionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/positions", async () => {
    const rows = await prisma.trade.findMany({ where: { status: "open" }, orderBy: { entryTime: "desc" } });
    return rows.map((t) => ({
      tradeId: t.id,
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      entryPrice: t.entryPrice,
      stopPrice: t.stopPrice,
      takeProfitPrice: t.takeProfitPrice,
      entryTime: t.entryTime,
      strategyId: t.strategyId,
      score: t.score,
      explanation: t.explanation,
    }));
  });

  app.get("/api/orders", async () => {
    const rows = await prisma.orderRecord.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      orderType: o.orderType,
      quantity: o.quantity,
      status: o.status,
      price: o.price,
      filledPrice: o.filledPrice,
      createdAt: o.createdAt,
    }));
  });
}
