/**
 * Execution Decision Engine orchestrator -- Phase 5: the single entry point
 * engine/loop.ts calls once a signal has cleared consensus and risk
 * approval, in place of immediately market-ordering. Builds the fair value
 * map, scores the entry ladder, advances the execution state machine, and
 * is the only place in this module that actually talks to the broker
 * (placing/checking/cancelling a resting limit order) or writes a Trade row
 * -- mirroring execution/engine.ts's own "single choke point" convention.
 *
 * One in-memory opportunity per symbol+side (module-level Map, reset on
 * restart), NOT per symbol alone -- a real account can only hold one net
 * position per symbol, but long and short opportunities can both be
 * *building* for the same symbol at once before either fills, and keying by
 * symbol alone let a later signal on the opposite side silently collide
 * with an already-resting opportunity's map slot (2026-07-20 incident: a
 * long signal reused a resting short's slot, read its "not flat" broker
 * check as its own fill, and recorded a fabricated long trade). See
 * `hasActiveOppositeSideOpportunity` below for the guard that now prevents
 * a second side from starting at all while one is already active.
 *
 * Polling an already-placed resting order for a fill must not depend on a
 * fresh signal recomputing its own stopPrice/quantity/etc -- the moment a
 * later tick's signal on the SAME side stops reaching consensus, that path
 * would've gone silent forever (same 2026-07-20 incident: a real fill sat
 * undetected for ~20 minutes because nothing else was calling this code).
 * `orderDetails` on the opportunity freezes what's needed to record a fill
 * independent of any fresh signal, and `pollRestingOpportunities` lets
 * loop.ts check every symbol every tick regardless of whether that tick's
 * signal reached consensus at all.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import type { BrokerClient } from "../brokers/types.js";
import { OrderSide, OrderType } from "../brokers/types.js";
import type { BrokerKind } from "../core/config.js";
import type { OhlcBar } from "../regime/indicators.js";
import type { EmaTrend } from "../analytics/emaTrend.js";
import { getOrderFlowHistory } from "../engine/liveOrderFlowCache.js";
import { buildFairValueMap } from "./fairValueMap.js";
import { scoreEntryLadder } from "./entryQualityModel.js";
import { advanceExecutionState, computeAgePenalty, type ExecutionOpportunity } from "./executionStateMachine.js";

const logger = childLogger("executionDecisionEngine");

const opportunities = new Map<string, ExecutionOpportunity>();

function opportunityKey(symbol: string, side: "long" | "short"): string {
  return `${symbol}:${side}`;
}

function oppositeSide(side: "long" | "short"): "long" | "short" {
  return side === "long" ? "short" : "long";
}

/** Test-only: clear in-memory opportunity state between tests. */
export function _resetExecutionOpportunitiesForTests(): void {
  opportunities.clear();
}

export interface ExecutionOpportunitySnapshot {
  symbol: string;
  side: "long" | "short";
  strategyId: string;
  state: ExecutionOpportunity["state"];
  bestEntryPrice: number | null;
  bestEntryScore: number | null;
  ageSeconds: number;
  cancelReason: string | null;
}

// Read-only view of the in-memory opportunity map -- surfaces "is the EDE
// actually engaged with this signal right now, and what is it doing" in the
// dashboard (see api/routes/execution.ts), since a resting/building
// opportunity has no Trade row yet and would otherwise be invisible next to
// the Recommendation feed's per-version score explanations.
export function getExecutionOpportunitiesSnapshot(): ExecutionOpportunitySnapshot[] {
  const now = Date.now();
  return [...opportunities.values()].map((o) => ({
    symbol: o.symbol,
    side: o.side,
    strategyId: o.strategyId,
    state: o.state,
    bestEntryPrice: o.bestEntry?.price ?? null,
    bestEntryScore: o.bestEntry?.score ?? null,
    ageSeconds: Math.round((now - o.createdAt.getTime()) / 1000),
    cancelReason: o.cancelReason,
  }));
}

// Hand-set against the operator's weights (which sum to ~105, not 100 --
// see entryQualityModel.ts). Lowered 70 -> 60 on 2026-07-20 (operator
// request) after watching several signals sit in building_entry for
// minutes without a ladder rung ever clearing 70. Revisit once Phase 6's
// logging has enough resolved trades to calibrate against, same posture as
// every other constant in this engine.
const MIN_ENTRY_QUALITY_THRESHOLD = 60;
// How many recent order-flow flush windows feed the fair value map's
// absorption/divergence reads.
const ORDER_FLOW_HISTORY_WINDOW = 20;

export interface EvaluateExecutionOpportunityParams {
  symbol: string;
  side: "long" | "short";
  strategyId: string;
  signalScore: number;
  currentPrice: Decimal;
  atrValue: Decimal;
  tickSize: Decimal;
  stopPrice: Decimal;
  takeProfitPrice: Decimal | null;
  quantity: number;
  bars: OhlcBar[];
  barTime: Date;
  emaTrend: EmaTrend;
  broker: BrokerClient;
  brokerKind: BrokerKind;
  accountId: number;
  brokerAccountId: string;
  regimeTrend: string;
  regimeVol: string;
  explanation: string;
  scoreId: number | null;
}

export interface EvaluateExecutionOpportunityResult {
  action: "waiting" | "placed_resting_order" | "already_resting" | "cancelled" | "filled";
  tradeId: number | null;
  reason: string;
}

// Shared by both the fresh-signal path (evaluateExecutionOpportunity, when a
// resting order happens to already be out) and the no-fresh-signal poll path
// (pollRestingOpportunities) -- everything it needs comes from the frozen
// `opportunity.orderDetails`, never from a caller's current-tick params, so
// both call sites see identical behavior.
async function checkRestingOrder(
  oppKey: string,
  opportunity: ExecutionOpportunity,
  broker: BrokerClient,
  brokerKind: BrokerKind,
  barTime: Date
): Promise<EvaluateExecutionOpportunityResult> {
  const { symbol, side } = opportunity;
  const details = opportunity.orderDetails!; // always set by the transition into resting_order below

  const isFlat = await broker.isPositionFlat?.(symbol);
  if (isFlat === false) {
    // isPositionFlat's own convention: false = confirmed still/now open --
    // the resting order filled. Create the Trade row now (not when the
    // order was placed), so "open" in the DB always means a real,
    // confirmed position, matching this codebase's existing standard.
    const fillPrice = new Decimal(opportunity.bestEntry!.price);
    // Time-to-fill is measured from when the resting order was actually
    // placed, not from opportunity creation (which also includes however
    // long building_entry took) -- Phase 6 data collection for the (still
    // deferred) weight recalibration.
    const timeToFillSeconds = opportunity.restingOrderPlacedAt
      ? Math.round((barTime.getTime() - opportunity.restingOrderPlacedAt.getTime()) / 1000)
      : null;
    const trade = await prisma.trade.create({
      data: {
        accountId: details.accountId,
        symbol,
        strategyId: opportunity.strategyId,
        side,
        quantity: details.quantity,
        entryTime: barTime,
        entryPrice: fillPrice.toString(),
        stopPrice: details.stopPrice.toString(),
        takeProfitPrice: details.takeProfitPrice?.toString(),
        score: opportunity.signalScore.toString(),
        entryQualityScore: opportunity.bestEntry!.score.toString(),
        timeToFillSeconds,
        regimeTrendAtEntry: details.regimeTrend,
        regimeVolAtEntry: details.regimeVol,
        explanation: `${details.explanation} [Execution Decision Engine: resting limit filled -- entry quality ${opportunity.bestEntry!.score.toFixed(1)}, fill price is an ESTIMATE (the configured limit price), not a confirmed broker fill]`,
        status: "open",
        brokerOrderId: opportunity.brokerOrderId ?? "",
        brokerKind,
      },
    });
    if (details.scoreId !== null) {
      await prisma.score.update({ where: { id: details.scoreId }, data: { tradeId: trade.id } });
    }
    // Mirrors execution/engine.ts's executeIfApproved -- /api/orders (see
    // api/routes/positions.ts) reads from this table, so an EDE-filled
    // trade without a matching row would silently vanish from that view.
    await prisma.orderRecord.create({
      data: {
        tradeId: trade.id,
        brokerOrderId: opportunity.brokerOrderId,
        accountId: details.accountId,
        symbol,
        orderType: "limit",
        side,
        quantity: details.quantity,
        price: fillPrice.toString(),
        status: "filled",
        filledAt: barTime,
        filledPrice: fillPrice.toString(),
      },
    });
    opportunities.delete(oppKey);
    logger.info({ symbol, side, tradeId: trade.id, entryPrice: fillPrice.toString() }, "execution_decision_engine_order_filled");
    return { action: "filled", tradeId: trade.id, reason: `resting limit order filled at ${fillPrice.toString()}` };
  }

  // Still resting -- advanceExecutionState treats resting_order as
  // terminal/broker-driven (it won't transition it), so the age check
  // that matters for an already-placed order is done directly here via
  // the same computeAgePenalty the pre-order path uses.
  const ageSeconds = (barTime.getTime() - opportunity.createdAt.getTime()) / 1000;
  if (computeAgePenalty(ageSeconds).shouldCancel) {
    const cancelResult = await broker.cancelRestingOrder?.(symbol);
    opportunities.delete(oppKey);
    logger.info({ symbol, side, ageSeconds }, "execution_decision_engine_cancelled_resting_order_age");
    return {
      action: "cancelled",
      tradeId: null,
      reason: `cancelled resting order -- exceeded max age (${(ageSeconds / 60).toFixed(1)} min)${cancelResult?.error ? `; cancel error: ${cancelResult.error}` : ""}`,
    };
  }
  return { action: "already_resting", tradeId: null, reason: `resting ${side} limit at ${opportunity.bestEntry!.price.toFixed(2)}, waiting to fill` };
}

/**
 * Checks every resting-order opportunity for `symbol` (both sides) for a
 * fill or an age-based cancellation, independent of whether this tick's
 * signal reached consensus at all. loop.ts calls this unconditionally once
 * per active instrument per tick -- see this file's header comment for why
 * that's necessary rather than relying on evaluateExecutionOpportunity's own
 * (fresh-signal-gated) resting-order check alone.
 */
export async function pollRestingOpportunities(params: {
  symbol: string;
  broker: BrokerClient;
  brokerKind: BrokerKind;
  barTime: Date;
}): Promise<EvaluateExecutionOpportunityResult[]> {
  const { symbol, broker, brokerKind, barTime } = params;
  const results: EvaluateExecutionOpportunityResult[] = [];
  for (const side of ["long", "short"] as const) {
    const oppKey = opportunityKey(symbol, side);
    const opportunity = opportunities.get(oppKey);
    if (!opportunity || opportunity.state !== "resting_order") continue;
    results.push(await checkRestingOrder(oppKey, opportunity, broker, brokerKind, barTime));
  }
  return results;
}

export async function evaluateExecutionOpportunity(params: EvaluateExecutionOpportunityParams): Promise<EvaluateExecutionOpportunityResult> {
  const {
    symbol, side, strategyId, signalScore, currentPrice, atrValue, tickSize, stopPrice, takeProfitPrice,
    quantity, bars, barTime, emaTrend, broker, brokerKind, accountId, brokerAccountId, regimeTrend, regimeVol, explanation, scoreId,
  } = params;

  const oppKey = opportunityKey(symbol, side);
  let opportunity = opportunities.get(oppKey);

  // A resting order is already out for this side -- check whether it filled
  // or should be cancelled, rather than starting a second one. (Also
  // reachable via pollRestingOpportunities without a fresh signal at all --
  // this path only exists here as a bonus early check when a fresh signal
  // happens to coincide with one.)
  if (opportunity && opportunity.state === "resting_order") {
    return checkRestingOrder(oppKey, opportunity, broker, brokerKind, barTime);
  }

  // A real account can only hold one net position per symbol -- refuse to
  // start (or advance) an opportunity on this side while the opposite side
  // already has one active. Without this, both sides could independently
  // reach "ready" and place competing resting orders on the same symbol, or
  // (the 2026-07-20 incident) a signal on this side could silently steal
  // the opposite side's map slot the moment it looked up "the" opportunity
  // for this symbol.
  if (opportunities.has(opportunityKey(symbol, oppositeSide(side)))) {
    return {
      action: "waiting",
      tradeId: null,
      reason: `declining -- opposite side (${oppositeSide(side)}) already has an active EDE opportunity for ${symbol}`,
    };
  }

  // No opportunity yet -- start one.
  if (!opportunity) {
    const stopDistance = Math.abs(currentPrice.toNumber() - stopPrice.toNumber());
    const rewardDistance = takeProfitPrice ? Math.abs(takeProfitPrice.toNumber() - currentPrice.toNumber()) : stopDistance * 3;
    opportunity = {
      symbol, side, strategyId, signalScore,
      createdAt: barTime,
      state: "waiting",
      bestEntry: null,
      brokerOrderId: null,
      cancelReason: null,
      restingOrderPlacedAt: null,
      orderDetails: null,
      baseline: { entryScore: 0, stopDistance, rewardDistance, atrValue: atrValue.toNumber(), trendSlope: emaTrend.slope },
    };
  }

  const orderFlowHistory = getOrderFlowHistory(symbol, ORDER_FLOW_HISTORY_WINDOW);
  const fvm = buildFairValueMap(bars, currentPrice.toNumber(), atrValue.toNumber(), orderFlowHistory);
  const impliedTarget =
    takeProfitPrice?.toNumber() ??
    (side === "long"
      ? currentPrice.toNumber() + Math.abs(currentPrice.toNumber() - stopPrice.toNumber()) * 3
      : currentPrice.toNumber() - Math.abs(currentPrice.toNumber() - stopPrice.toNumber()) * 3);

  const scores = scoreEntryLadder({
    currentPrice: currentPrice.toNumber(),
    tickSize: tickSize.toNumber(),
    side,
    stopPrice: stopPrice.toNumber(),
    targetPrice: impliedTarget,
    emaTrend,
    fvm,
  });

  // Baseline is set the first time this opportunity is scored, so later
  // opportunity-cost comparisons are against the setup's original quality.
  if (opportunity.baseline.entryScore === 0 && scores.length > 0) {
    opportunity.baseline.entryScore = Math.max(...scores.map((s) => s.score));
  }

  const currentStopDistance = Math.abs(currentPrice.toNumber() - stopPrice.toNumber());
  const currentRewardDistance = takeProfitPrice ? Math.abs(takeProfitPrice.toNumber() - currentPrice.toNumber()) : opportunity.baseline.rewardDistance;

  const advanced = advanceExecutionState({
    opportunity,
    scores,
    minThreshold: MIN_ENTRY_QUALITY_THRESHOLD,
    now: barTime,
    currentStopDistance,
    currentRewardDistance,
    currentAtrValue: atrValue.toNumber(),
    currentTrendSlope: emaTrend.slope,
  });

  if (advanced.opportunity.state === "cancelled") {
    opportunities.delete(oppKey);
    logger.info({ symbol, side, reason: advanced.opportunity.cancelReason }, "execution_decision_engine_cancelled_before_order");
    return { action: "cancelled", tradeId: null, reason: advanced.opportunity.cancelReason ?? "cancelled" };
  }

  if (advanced.opportunity.state !== "ready" || !advanced.opportunity.bestEntry) {
    opportunities.set(oppKey, advanced.opportunity);
    return {
      action: "waiting",
      tradeId: null,
      reason: `building entry -- best candidate ${advanced.opportunity.bestEntry?.score.toFixed(1) ?? "n/a"}, needs ${MIN_ENTRY_QUALITY_THRESHOLD}`,
    };
  }

  // READY -- place the resting limit order at the highest-scored price.
  const entryPrice = new Decimal(advanced.opportunity.bestEntry.price);
  const orderSide = side === "long" ? OrderSide.BUY : OrderSide.SELL;
  const result = await broker.placeOrder({
    accountId: brokerAccountId,
    symbol,
    side: orderSide,
    orderType: OrderType.LIMIT,
    quantity,
    limitPrice: entryPrice,
    stopLossPrice: stopPrice,
    takeProfitPrice: takeProfitPrice ?? undefined,
    customTag: `${strategyId}:${barTime.toISOString()}`,
    referencePrice: entryPrice,
  });

  if (result.status === "rejected") {
    logger.warn({ symbol, side, error: result.error }, "execution_decision_engine_resting_order_rejected");
    opportunities.delete(oppKey);
    return { action: "cancelled", tradeId: null, reason: `resting order rejected: ${result.error}` };
  }

  opportunities.set(oppKey, {
    ...advanced.opportunity,
    state: "resting_order",
    brokerOrderId: result.brokerOrderId,
    restingOrderPlacedAt: barTime,
    orderDetails: { accountId, quantity, stopPrice, takeProfitPrice, regimeTrend, regimeVol, explanation, scoreId },
  });
  logger.info({ symbol, side, price: entryPrice.toString(), score: advanced.opportunity.bestEntry.score }, "execution_decision_engine_resting_order_placed");
  return {
    action: "placed_resting_order",
    tradeId: null,
    reason: `resting ${orderSide} limit at ${entryPrice.toString()} (entry quality ${advanced.opportunity.bestEntry.score.toFixed(1)})`,
  };
}
