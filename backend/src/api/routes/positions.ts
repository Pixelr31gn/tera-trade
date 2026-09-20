import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getBroker } from "../../brokers/index.js";
import { BrokerKind, getSettings } from "../../core/config.js";
import { ensureAccountForBrokerKind, ensureDefaultAccount } from "../../engine/bootstrap.js";
import { childLogger } from "../../core/logger.js";
import type { ActionResult } from "./trades.js";

export interface LetItRideResult {
  status: "let_it_ride_enabled";
}

/**
 * v1.3 operator override: once a position's real trailing-stop order is
 * live, this cancels the internal take-profit check in engine/loop.ts's
 * manageLiveOpenTrade so the trade can run past its original target -- for
 * the one case a rule-based system can't cover on its own, the operator (or,
 * 2026-08-28, the assistant) seeing something a purely rule-based system
 * doesn't. Irreversible by design (no "un-ride" toggle) -- flipping it back
 * off with a stale takeProfitPrice the market has already passed would
 * immediately force-close the position the next tick, which is never what
 * "I changed my mind" should do to a real position. Shared by the dashboard
 * route below and the assistant's let_it_ride tool -- one implementation.
 */
export async function enableLetItRide(tradeId: number): Promise<ActionResult<LetItRideResult>> {
  const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
  if (!trade || trade.status !== "open") return { ok: false, statusCode: 404, error: "Open position not found" };

  // 2026-09-04: if a real broker-side take-profit LIMIT order is already resting (see
  // engine/loop.ts's activateTakeProfitOrder), it would otherwise still close this position at
  // the original target regardless of letItRide -- our own software-side check already defers to
  // letItRide, but a real resting order doesn't know about that flag at all. Cancel it here so
  // "let it ride" actually does that; best-effort (log, don't fail the request) since letItRide
  // itself should still take effect even if the cancel click fails for some reason.
  if (trade.takeProfitOrderPlaced) {
    const broker = await getBroker(trade.brokerKind as BrokerKind);
    if (broker.cancelRestingOrder) {
      await broker.connect();
      const result = await broker.cancelRestingOrder(trade.symbol).catch((err: unknown) => ({ status: "rejected" as const, error: String(err), brokerOrderId: "" }));
      await broker.disconnect();
      if (result.status === "rejected") {
        childLogger("letItRide").warn({ tradeId, symbol: trade.symbol, error: result.error }, "let_it_ride_cancel_take_profit_order_failed");
      } else {
        await prisma.trade.update({ where: { id: tradeId }, data: { takeProfitOrderPlaced: false } });
      }
    }
  }

  await prisma.trade.update({ where: { id: tradeId }, data: { letItRide: true } });
  return { ok: true, data: { status: "let_it_ride_enabled" } };
}

export interface ClosePositionResult {
  status: "close_submitted";
  detail: unknown;
}

/**
 * Manual close for a position opened via BrowserControlBroker (or Tradesea's
 * equivalent) -- this system does not yet detect broker-side bracket fills
 * (stop/target hit server-side), so a position that hasn't hit its bracket
 * needs an explicit close action rather than waiting for the engine to
 * notice. Shared by the dashboard route below and the assistant's
 * close_position tool -- one implementation, not a second copy of the
 * broker-resolution-by-trade logic.
 */
export async function closeOpenPosition(tradeId: number): Promise<ActionResult<ClosePositionResult>> {
  const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
  if (!trade || trade.status !== "open") return { ok: false, statusCode: 404, error: "Open position not found" };

  // Must close via the broker this specific trade actually opened under
  // (trade.brokerKind), not whatever settings.brokerKind currently says --
  // those can now disagree, e.g. closing an old LIVE position while the
  // system has since been switched to PAPER mode would otherwise try to
  // close it with the simulated broker, which never had it.
  const broker = await getBroker(trade.brokerKind as BrokerKind);
  if (!broker.requestClosePosition) {
    return { ok: false, statusCode: 400, error: `${trade.brokerKind} broker does not support closing positions via this action` };
  }

  await broker.connect();
  const result = await broker.requestClosePosition(trade.symbol);
  await broker.disconnect();

  if (result.status === "rejected") return { ok: false, statusCode: 409, error: result.error ?? "broker rejected the close" };
  return { ok: true, data: { status: "close_submitted", detail: result } };
}

/**
 * Resolves the primary account plus, when Tradesea is configured, its own
 * separate account -- a real Tradesea position the operator can't see here
 * is the same class of incident CLAUDE.md invariant 6 warns about (a Trade
 * row disagreeing with reality), just inverted: a real position existing
 * that's invisible, rather than a phantom one that doesn't. See
 * engine/loop.ts's evaluateNewSignals for the equivalent gate on the
 * execution side.
 */
async function resolveVisibleAccountIds(): Promise<number[]> {
  const account = await ensureDefaultAccount();
  const ids = [account.id];
  if (getSettings().tradeseaEnabled) {
    const tradeseaAccount = await ensureAccountForBrokerKind(BrokerKind.TRADESEA_BROWSER_CONTROL);
    ids.push(tradeseaAccount.id);
  }
  return ids;
}

/** Shared by GET /api/positions and the assistant's get_positions tool. */
export async function getOpenPositions() {
  // Deliberately NOT scoped to the current mode's broker (unlike
  // performance/journal/equity, which are) -- paper and live can now both
  // have genuinely open positions at the same time (see engine/loop.ts's
  // TradingEngine holding both brokers simultaneously), and hiding a real
  // open position just because you happen to be viewing paper mode right
  // now would be a real risk-visibility gap, not a feature. brokerKind is
  // included on each row instead, so the UI can label which is which.
  const accountIds = await resolveVisibleAccountIds();
  const rows = await prisma.trade.findMany({ where: { accountId: { in: accountIds }, status: "open" }, orderBy: { entryTime: "desc" } });
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
    takeProfitOrderPlaced: t.takeProfitOrderPlaced,
    letItRide: t.letItRide,
  }));
}

/** Shared by GET /api/orders and the assistant's get_orders tool. */
export async function getOpenOrders() {
  const accountIds = await resolveVisibleAccountIds();
  const rows = await prisma.orderRecord.findMany({ where: { accountId: { in: accountIds } }, orderBy: { createdAt: "desc" }, take: 100 });
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
}

export async function positionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/positions", async () => getOpenPositions());

  app.post<{ Params: { tradeId: string } }>("/api/positions/:tradeId/let-it-ride", async (request, reply) => {
    const result = await enableLetItRide(Number(request.params.tradeId));
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return result.data;
  });

  app.post<{ Params: { tradeId: string } }>("/api/positions/:tradeId/close", async (request, reply) => {
    const result = await closeOpenPosition(Number(request.params.tradeId));
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return result.data;
  });

  app.get("/api/orders", async () => getOpenOrders());
}
