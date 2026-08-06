import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getBroker } from "../../brokers/index.js";
import type { BrokerKind } from "../../core/config.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";

export async function positionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/positions", async () => {
    // Deliberately NOT scoped to the current mode's broker (unlike
    // performance/journal/equity, which are) -- paper and live can now both
    // have genuinely open positions at the same time (see engine/loop.ts's
    // TradingEngine holding both brokers simultaneously), and hiding a real
    // open position just because you happen to be viewing paper mode right
    // now would be a real risk-visibility gap, not a feature. brokerKind is
    // included on each row instead, so the UI can label which is which.
    const account = await ensureDefaultAccount();
    const rows = await prisma.trade.findMany({ where: { accountId: account.id, status: "open" }, orderBy: { entryTime: "desc" } });
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
      brokerKind: t.brokerKind,
      trailingStopPlaced: t.trailingStopPlaced,
      letItRide: t.letItRide,
    }));
  });

  // v1.3 operator override: once a position's real trailing-stop order is
  // live, this cancels the internal take-profit check in
  // engine/loop.ts's manageLiveOpenTrade so the trade can run past its
  // original target -- for the one case a rule-based system can't cover on
  // its own, the operator seeing something it doesn't. Irreversible via this
  // endpoint by design (no "un-ride" toggle) -- flipping it back off with a
  // stale takeProfitPrice the market has already passed would immediately
  // force-close the position the next tick, which is never what "I changed
  // my mind" should do to a real position.
  app.post<{ Params: { tradeId: string } }>("/api/positions/:tradeId/let-it-ride", async (request, reply) => {
    const tradeId = Number(request.params.tradeId);
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade || trade.status !== "open") return reply.code(404).send({ error: "Open position not found" });

    await prisma.trade.update({ where: { id: tradeId }, data: { letItRide: true } });
    return { status: "let_it_ride_enabled" };
  });

  // Manual close for a position opened via BrowserControlBroker -- this
  // system does not yet detect broker-side bracket fills (stop/target hit
  // server-side), so a position that hasn't hit its bracket needs an
  // explicit close action rather than waiting for the engine to notice.
  app.post<{ Params: { tradeId: string } }>("/api/positions/:tradeId/close", async (request, reply) => {
    const tradeId = Number(request.params.tradeId);
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade || trade.status !== "open") return reply.code(404).send({ error: "Open position not found" });

    // Must close via the broker this specific trade actually opened under
    // (trade.brokerKind), not whatever settings.brokerKind currently says --
    // those can now disagree, e.g. closing an old LIVE position while the
    // system has since been switched to PAPER mode would otherwise try to
    // close it with the simulated broker, which never had it.
    const broker = await getBroker(trade.brokerKind as BrokerKind);
    if (!broker.requestClosePosition) {
      return reply.code(400).send({ error: `${trade.brokerKind} broker does not support closing positions via this action` });
    }

    await broker.connect();
    const result = await broker.requestClosePosition(trade.symbol);
    await broker.disconnect();

    if (result.status === "rejected") return reply.code(409).send({ error: result.error });
    return { status: "close_submitted", detail: result };
  });

  app.get("/api/orders", async () => {
    const account = await ensureDefaultAccount();
    const rows = await prisma.orderRecord.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "desc" }, take: 100 });
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
