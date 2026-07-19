/**
 * Execution engine: routes an approved, scored setup to an actual order --
 * or, in ANALYSIS_ONLY mode, to nowhere at all.
 *
 * This is the only module allowed to call BrokerClient.placeOrder. Every
 * other module works with Signal/GatedScore/RiskAssessment objects and never
 * touches the broker directly, so the mode gate here is the single choke
 * point that guarantees ANALYSIS_ONLY never places an order, real or simulated.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { TradingMode, type BrokerKind } from "../core/config.js";
import type { BrokerClient, OrderRequest } from "../brokers/types.js";
import { OrderSide, OrderType } from "../brokers/types.js";
import type { RiskAssessment } from "../risk/engine.js";
import type { GatedScore } from "../scoring/gate.js";
import type { Signal } from "../strategy/types.js";

const logger = childLogger("execution");

export interface ExecutionResult {
  executed: boolean;
  tradeId: number | null;
  reason: string;
}

export async function executeIfApproved(
  broker: BrokerClient,
  brokerKind: BrokerKind,
  mode: TradingMode,
  accountId: number,
  brokerAccountId: string,
  signal: Signal,
  gated: GatedScore,
  assessment: RiskAssessment,
  entryPrice: Decimal,
  regimeTrend: string,
  regimeVol: string,
  explanation: string,
  entryTime: Date = new Date(),
  scoreId: number | null = null
): Promise<ExecutionResult> {
  if (gated.decision !== "taken") {
    return { executed: false, tradeId: null, reason: "setup did not clear the scoring threshold" };
  }
  if (!assessment.approved) {
    return { executed: false, tradeId: null, reason: "risk engine did not approve this trade" };
  }

  if (mode === TradingMode.ANALYSIS_ONLY) {
    logger.info({ symbol: signal.symbol, side: signal.side }, "analysis_only_skip");
    return { executed: false, tradeId: null, reason: "analysis-only mode: setup qualified but no order was placed" };
  }

  const side = signal.side === "long" ? OrderSide.BUY : OrderSide.SELL;
  const orderRequest: OrderRequest = {
    accountId: brokerAccountId,
    symbol: signal.symbol,
    side,
    orderType: OrderType.MARKET,
    quantity: assessment.quantity,
    stopLossPrice: assessment.stopPrice ?? undefined,
    takeProfitPrice: assessment.takeProfitPrice ?? undefined,
    trailTicks: assessment.trailTicks ?? undefined,
    customTag: `${signal.strategyId}:${entryTime.toISOString()}`,
    referencePrice: entryPrice,
  };
  const result = await broker.placeOrder(orderRequest);
  if (result.status === "rejected") {
    logger.warn({ symbol: signal.symbol, error: result.error }, "order_rejected");
    return { executed: false, tradeId: null, reason: `broker rejected the order: ${result.error}` };
  }

  const fillPrice = result.filledPrice ?? entryPrice;
  const trade = await prisma.trade.create({
    data: {
      accountId,
      symbol: signal.symbol,
      strategyId: signal.strategyId,
      side: signal.side,
      quantity: assessment.quantity,
      entryTime,
      entryPrice: fillPrice.toString(),
      stopPrice: assessment.stopPrice!.toString(),
      takeProfitPrice: assessment.takeProfitPrice?.toString(),
      score: gated.probability.toString(),
      regimeTrendAtEntry: regimeTrend,
      regimeVolAtEntry: regimeVol,
      explanation,
      status: "open",
      brokerOrderId: result.brokerOrderId,
      brokerKind,
    },
  });

  await prisma.orderRecord.create({
    data: {
      tradeId: trade.id,
      brokerOrderId: result.brokerOrderId,
      accountId,
      symbol: signal.symbol,
      orderType: "market",
      side: signal.side,
      quantity: assessment.quantity,
      price: fillPrice.toString(),
      status: result.status === "filled" ? "filled" : "pending",
      filledAt: result.filledAt,
      filledPrice: fillPrice.toString(),
    },
  });

  // Links the Score row back to the Trade it produced, so the outcome
  // evaluator (engine/outcomeEvaluator.ts) labels it from the trade's real
  // fill/exit/PnL instead of falling back to the same retrospective
  // simulation used for setups that were never actually taken.
  if (scoreId !== null) {
    await prisma.score.update({ where: { id: scoreId }, data: { tradeId: trade.id } });
  }

  logger.info({ tradeId: trade.id, symbol: signal.symbol, side: signal.side, quantity: assessment.quantity }, "trade_opened");
  return { executed: true, tradeId: trade.id, reason: "order placed" };
}
