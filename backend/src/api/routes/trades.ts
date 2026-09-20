import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getBroker, OrderSide, OrderType } from "../../brokers/index.js";
import { BrokerKind, getSettings, TradingMode } from "../../core/config.js";
import { brokerKindForAccount, computeAccountEquity, computeAccountRiskState, currentBrokerKind } from "../../engine/accounting.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";
import { getSystemState } from "../../execution/mode.js";
import { checkCircuitBreakers, type RiskLimitsConfig } from "../../risk/index.js";

export interface ManualTradeInput {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  stopPrice: number;
  takeProfitPrice?: number;
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; statusCode: number; error: string };

export interface ManualTradeResult {
  status: "placed";
  tradeId: number;
  fillPrice: string;
}

/**
 * Places a manual, user-initiated order -- shared by the Quick Order Panel
 * route below and (2026-08-28) the assistant's place_manual_order tool, so
 * there is exactly one implementation of this real-money code path, not a
 * route-only copy and a second one reimplemented inside assistant/tools.ts.
 * Bypasses the scoring engine's confidence gates (a human/the assistant is
 * directly deciding to place this trade), but NOT the account's risk
 * management: circuit breakers and a mandatory stop are still enforced
 * exactly as they are for automated entries, and it goes through the same
 * BrokerClient the engine uses.
 */
export async function placeManualOrder(input: ManualTradeInput): Promise<ActionResult<ManualTradeResult>> {
  const { symbol, side, quantity, stopPrice, takeProfitPrice } = input;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, statusCode: 400, error: "quantity must be a positive integer" };
  }
  if (!Number.isFinite(stopPrice)) {
    return { ok: false, statusCode: 400, error: "a stop price is required -- no stop, no trade" };
  }

  const systemState = await getSystemState();
  if (systemState.mode === TradingMode.ANALYSIS_ONLY) {
    return { ok: false, statusCode: 400, error: "cannot place an order in analysis_only mode" };
  }
  if (systemState.killSwitch) {
    return { ok: false, statusCode: 400, error: `kill switch is active: ${systemState.killSwitchReason}` };
  }

  const account = await ensureDefaultAccount();
  const existingOpen = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" } });
  if (existingOpen) {
    return { ok: false, statusCode: 409, error: `${symbol} already has an open position (trade #${existingOpen.id})` };
  }

  const lastBar = await prisma.bar.findFirst({ where: { symbol }, orderBy: { time: "desc" } });
  if (!lastBar) return { ok: false, statusCode: 400, error: `no recent price data for ${symbol}` };
  const referencePrice = new Decimal(lastBar.close.toString());

  const riskLimitsRow = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
  const limits: RiskLimitsConfig = {
    perTradeRiskPct: new Decimal(riskLimitsRow.perTradeRiskPct.toString()),
    maxDailyLossPct: new Decimal(riskLimitsRow.maxDailyLossPct.toString()),
    maxTrailingDrawdownPct: new Decimal(riskLimitsRow.maxTrailingDrawdownPct.toString()),
    maxConsecutiveLosses: riskLimitsRow.maxConsecutiveLosses,
    maxDailyTrades: riskLimitsRow.maxDailyTrades,
    maxPositionSize: riskLimitsRow.maxPositionSize,
    maxDailyLossDollars: riskLimitsRow.maxDailyLossDollars ? new Decimal(riskLimitsRow.maxDailyLossDollars.toString()) : null,
  };
  const equity = await computeAccountEquity(account, new Map([[symbol, referencePrice]]));
  const accountState = await computeAccountRiskState(account, equity);
  const breaker = checkCircuitBreakers(accountState, limits);
  if (!breaker.allowed) {
    return { ok: false, statusCode: 409, error: breaker.reason ?? "circuit breaker blocked this trade" };
  }
  if (quantity > limits.maxPositionSize) {
    return { ok: false, statusCode: 400, error: `quantity ${quantity} exceeds the account's max position size of ${limits.maxPositionSize}` };
  }

  const settings = getSettings();
  const broker = await getBroker(settings.brokerKind);
  await broker.connect();
  const brokerAccountId = (await broker.getAccounts())[0]!.accountId;

  const orderSide = side === "long" ? OrderSide.BUY : OrderSide.SELL;
  const result = await broker.placeOrder({
    accountId: brokerAccountId,
    symbol,
    side: orderSide,
    orderType: OrderType.MARKET,
    quantity,
    stopLossPrice: new Decimal(stopPrice),
    takeProfitPrice: takeProfitPrice !== undefined ? new Decimal(takeProfitPrice) : undefined,
    referencePrice,
    customTag: `manual:${Date.now()}`,
  });
  await broker.disconnect();

  if (result.status === "rejected") {
    return { ok: false, statusCode: 409, error: result.error ?? "broker rejected the order" };
  }

  const fillPrice = result.filledPrice ?? referencePrice;
  const explanation = `MANUAL ${side.toUpperCase()} ${symbol}: entered manually via dashboard @ ${fillPrice}. Stop ${stopPrice}${takeProfitPrice !== undefined ? `, target ${takeProfitPrice}` : ""}.`;

  const trade = await prisma.trade.create({
    data: {
      accountId: account.id,
      symbol,
      strategyId: "manual",
      side,
      quantity,
      entryTime: new Date(),
      entryPrice: fillPrice.toString(),
      stopPrice: stopPrice.toString(),
      takeProfitPrice: takeProfitPrice?.toString(),
      explanation,
      status: "open",
      brokerOrderId: result.brokerOrderId,
      // Without this, the row falls back to the schema's "simulated"
      // default even when this order just went out for real through the
      // live broker -- manageOpenTrades branches on this field, so a real
      // live position would silently get managed as if it were paper (the
      // fake SimulatedBroker's closePosition is a no-op, so a "hit stop"
      // reading would just mark this row closed in the DB without ever
      // sending a real close command). 2026-07-21 incident: exactly this,
      // confirmed live -- see trade #171.
      brokerKind: await currentBrokerKind(),
    },
  });

  await prisma.orderRecord.create({
    data: {
      tradeId: trade.id,
      brokerOrderId: result.brokerOrderId,
      accountId: account.id,
      symbol,
      orderType: "market",
      side,
      quantity,
      price: fillPrice.toString(),
      status: result.status === "filled" ? "filled" : "pending",
      filledAt: result.filledAt,
      filledPrice: fillPrice.toString(),
    },
  });

  return { ok: true, data: { status: "placed", tradeId: trade.id, fillPrice: fillPrice.toString() } };
}

export async function tradesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post<{ Body: ManualTradeInput }>("/api/trades/manual", async (request, reply) => {
    const result = await placeManualOrder(request.body);
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return result.data;
  });

  app.get<{ Querystring: { status?: string; symbol?: string; limit?: string; accountId?: string } }>("/api/trades", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 200), 1000);
    return getTrades({
      status: request.query.status,
      symbol: request.query.symbol,
      limit,
      accountId: request.query.accountId ? Number(request.query.accountId) : undefined,
    });
  });
}

export interface GetTradesParams {
  status?: string;
  symbol?: string;
  limit: number;
  accountId?: number;
}

/** Shared by GET /api/trades and the assistant's get_trades tool. */
export async function getTrades({ status, symbol, limit, accountId }: GetTradesParams) {
  // Scoped to the broker matching the current mode (paper vs live) so a
  // paper run never shows real Topstep trades, or vice versa -- paper and
  // live share one account row, so this previously only claimed to filter
  // by mode in its own comment without actually doing so (2026-07-15
  // operator report: switching modes didn't change what was displayed).
  //
  // accountId (2026-08-28): optional, defaults to the primary account --
  // pass Tradesea's own account id to see its trades instead. See
  // brokerKindForAccount's own comment for why the brokerKind resolution
  // has to branch on which account this is, not just currentBrokerKind().
  //
  // 2026-09-10: an exact brokerKind match (below) was fine while the only
  // real distinction this needed to make was simulated-vs-live -- it broke
  // the moment BROKER_KIND switched from browser_control to projectx mid-
  // session (a real, live operator switch, not a paper/live mode change):
  // every one of 311 existing closed trades was stamped brokerKind
  // "browser_control", none matched the new "projectx" filter, and the
  // entire trade history silently vanished from the dashboard. Simulated and
  // Tradesea trades still need an exact match (never mix paper with live, or
  // Tradesea's separate venue with TopstepX's) -- only the two TopstepX-
  // access-method kinds (browser_control/projectx, both genuinely "live on
  // this same account") are broadened to match either, so switching between
  // them never hides prior history again.
  const account = accountId ? await prisma.account.findUniqueOrThrow({ where: { id: accountId } }) : await ensureDefaultAccount();
  const brokerKind = await brokerKindForAccount(account);
  const brokerKindFilter =
    brokerKind === BrokerKind.SIMULATED || brokerKind === BrokerKind.TRADESEA_BROWSER_CONTROL
      ? { brokerKind }
      : { brokerKind: { in: [BrokerKind.PROJECTX, BrokerKind.BROWSER_CONTROL] } };
  const rows = await prisma.trade.findMany({
    where: { accountId: account.id, ...brokerKindFilter, ...(status ? { status } : {}), ...(symbol ? { symbol } : {}) },
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
    stopPrice: t.stopPrice,
    takeProfitPrice: t.takeProfitPrice,
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
}
