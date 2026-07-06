import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getBroker } from "../../brokers/index.js";
import { getSettings } from "../../core/config.js";

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

  // Manual close for a position opened via BrowserControlBroker -- this
  // system does not yet detect broker-side bracket fills (stop/target hit
  // server-side), so a position that hasn't hit its bracket needs an
  // explicit close action rather than waiting for the engine to notice.
  app.post<{ Params: { tradeId: string } }>("/api/positions/:tradeId/close", async (request, reply) => {
    const tradeId = Number(request.params.tradeId);
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade || trade.status !== "open") return reply.code(404).send({ error: "Open position not found" });

    const settings = getSettings();
    const broker = await getBroker(settings.brokerKind);
    if (!broker.requestClosePosition) {
      return reply.code(400).send({ error: `${settings.brokerKind} broker does not support closing positions via this action` });
    }

    await broker.connect();
    const result = await broker.requestClosePosition(trade.symbol);
    await broker.disconnect();

    if (result.status === "rejected") return reply.code(409).send({ error: result.error });
    return { status: "close_submitted", detail: result };
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
