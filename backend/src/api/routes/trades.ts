import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getBroker, OrderSide, OrderType } from "../../brokers/index.js";
import { getSettings, TradingMode } from "../../core/config.js";
import { computeAccountEquity, computeAccountRiskState } from "../../engine/accounting.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";
import { getSystemState } from "../../execution/mode.js";
import { checkCircuitBreakers, type RiskLimitsConfig } from "../../risk/index.js";

interface ManualTradeBody {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  stopPrice: number;
  takeProfitPrice?: number;
}

export async function tradesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  // Manual, user-initiated order -- the Quick Order Panel. This bypasses the
  // scoring engine's confidence gates (a human is directly deciding to place
  // this trade), but NOT the account's risk management: circuit breakers and
  // a mandatory stop are still enforced exactly as they are for automated
  // entries, and it goes through the same BrokerClient the engine uses.
  app.post<{ Body: ManualTradeBody }>("/api/trades/manual", async (request, reply) => {
    const { symbol, side, quantity, stopPrice, takeProfitPrice } = request.body;

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return reply.code(400).send({ error: "quantity must be a positive integer" });
    }
    if (!Number.isFinite(stopPrice)) {
      return reply.code(400).send({ error: "a stop price is required -- no stop, no trade" });
    }

    const systemState = await getSystemState();
    if (systemState.mode === TradingMode.ANALYSIS_ONLY) {
      return reply.code(400).send({ error: "cannot place an order in analysis_only mode" });
    }
    if (systemState.killSwitch) {
      return reply.code(400).send({ error: `kill switch is active: ${systemState.killSwitchReason}` });
    }

    const account = await ensureDefaultAccount();
    const existingOpen = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" } });
    if (existingOpen) {
      return reply.code(409).send({ error: `${symbol} already has an open position (trade #${existingOpen.id})` });
    }

    const lastBar = await prisma.bar.findFirst({ where: { symbol }, orderBy: { time: "desc" } });
    if (!lastBar) return reply.code(400).send({ error: `no recent price data for ${symbol}` });
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
      return reply.code(409).send({ error: breaker.reason });
    }
    if (quantity > limits.maxPositionSize) {
      return reply.code(400).send({ error: `quantity ${quantity} exceeds the account's max position size of ${limits.maxPositionSize}` });
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
      return reply.code(409).send({ error: result.error ?? "broker rejected the order" });
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

    return { status: "placed", tradeId: trade.id, fillPrice: fillPrice.toString() };
  });

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
