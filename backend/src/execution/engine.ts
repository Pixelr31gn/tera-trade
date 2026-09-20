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

// Limit-only entries (2026-08-07, operator request: "as fast as possible,
// only enter using limit orders"): every entry now rests at the signal's own
// reference price instead of chasing the market -- no slippage past the
// price the setup was actually scored at. If it hasn't filled within this
// window, cancel it and skip the trade entirely (operator's explicit call --
// no fallback to a market order) rather than wait indefinitely or chase a
// worse price. Same 750ms poll cadence as browserControlBroker.ts's
// FILL_CONFIRMATION_DELAY_MS for consistency; fewer retries (4 vs that
// file's 4) since "as fast as possible" was the explicit ask and a limit
// order that hasn't filled in ~3s on a fast-moving continuous-scan signal is
// unlikely to without the market coming back to it. SimulatedBroker never
// returns "pending" (it fills immediately regardless of orderType -- see
// simulatedBroker.ts's placeOrder), so this polling path only ever runs
// live; paper mode is unaffected.
//
// Widened to a 60-second window (2026-08-10, operator request: "count down
// on limit order should be 60 seconds") -- the original ~3s window is
// superseded, not the underlying design (still cancel-and-skip, never fall
// back to a market order). Poll cadence moved off the 750ms
// browserControlBroker.ts-consistency value to a flat 1s: at a 60s total
// window the original consistency rationale no longer carries much weight,
// and 61 retries * 1000ms gives an exact, easy-to-reason-about 60.000s
// rather than a 750ms-derived fraction.
//
// Widened again to a 10-minute window (2026-08-12, operator request: "add a
// new timer to resting order of 10 minutes before expiration") -- same
// design, still cancel-and-skip on expiry, never a market-order fallback.
// 601 retries * 1000ms = exactly 600.000s (10:00) for the same reason 61 was
// chosen for 60s above: (RETRIES - 1) * DELAY_MS is what the expiry log
// message and the reason string both compute from, so the retry count is the
// one number that has to change to retarget the window.
//
// Limit-only entries REVERTED back to market orders (2026-08-13, operator
// request: "whatever paper trading is doing right now when it comes to
// executions thats exactly how live trading should be executing" --
// confirmed explicitly after being shown the concrete tradeoff, i.e. that
// this reintroduces slippage risk). Paper's SimulatedBroker has always
// filled every order instantly regardless of orderType; live's resting
// limit order could sit unfilled and get cancelled after this window,
// meaning a setup paper "took" could go unexecuted live. Orders are placed
// as OrderType.MARKET below now, so browserControlBroker.placeOrder's
// market-order path (its own, separate, already-hardened
// confirmPositionOpened check -- 4 attempts, 750ms apart) is what confirms
// the fill, and it never returns "pending" -- only "filled" or "rejected".
// This block (and LIMIT_FILL_CONFIRMATION_RETRIES/_DELAY_MS below) is left
// in place, not deleted, as a defensive no-op: harmless if unreached, and a
// one-line revert (orderType: OrderType.LIMIT below) is all a future
// switch back would need. Exported for tests/executionEngine.test.ts, which
// drives these with fake timers rather than hardcoding a second, drifting
// copy of the numbers.
export const LIMIT_FILL_CONFIRMATION_RETRIES = 601;
export const LIMIT_FILL_CONFIRMATION_DELAY_MS = 1000;

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

  // Tried a pre-entry broker.isPositionFlat() check here (2026-07-19
  // operator request, as a belt-and-suspenders check alongside the DB-side
  // `hasOpen` check upstream in loop.ts) but reverted it the same night:
  // BrowserControlBroker's isPositionFlat reads a DOM element that, in this
  // "nothing tracked, verify truly flat" context, doesn't actually contain
  // any position-status text at all (confirmed via diagnostic logging --
  // see git history) -- it was returning a confident-looking `false` on a
  // genuinely flat account, blocking every real entry. The exact same
  // function IS reliable in manageLiveOpenTrade's different context
  // (checking whether an already-tracked open trade has closed), so that
  // usage is untouched. The DB-side `hasOpen` check remains the only
  // pre-entry guard until isPositionFlat's DOM read is fixed to target the
  // right element.
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
  let result = await broker.placeOrder(orderRequest);
  if (result.status === "rejected") {
    logger.warn({ symbol: signal.symbol, error: result.error }, "order_rejected");
    return { executed: false, tradeId: null, reason: `broker rejected the order: ${result.error}` };
  }

  // Defensive fallback, not the normal path since the 2026-08-13 revert to
  // market orders above (see LIMIT_FILL_CONFIRMATION_RETRIES's comment) --
  // browserControlBroker's market-order path already confirms the fill
  // itself and only ever returns "filled" or "rejected", never "pending".
  // Kept in case a future broker/order-type combination legitimately rests
  // an order: poll for a real fill via isPositionFlat becoming false, and
  // cancel + skip the trade if it doesn't fill in time. SimulatedBroker
  // always returns "filled" directly, so this block never runs in paper mode.
  if (result.status === "pending") {
    let filled = false;
    for (let attempt = 0; attempt < LIMIT_FILL_CONFIRMATION_RETRIES; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, LIMIT_FILL_CONFIRMATION_DELAY_MS));
      const isFlat = await broker.isPositionFlat?.(signal.symbol).catch(() => null);
      if (isFlat === false) {
        filled = true;
        break;
      }
    }
    if (!filled) {
      const cancelResult = await broker.cancelRestingOrder?.(signal.symbol).catch(() => null);
      logger.info({ symbol: signal.symbol, side: signal.side, limitPrice: entryPrice.toString(), cancelled: cancelResult?.status ?? "unavailable" }, "limit_order_expired_unfilled");
      return { executed: false, tradeId: null, reason: `limit order at ${entryPrice.toString()} did not fill within ${((LIMIT_FILL_CONFIRMATION_RETRIES - 1) * LIMIT_FILL_CONFIRMATION_DELAY_MS) / 1000}s -- cancelled, trade skipped` };
    }
    // Confirmed filled -- record it as such so the Trade/OrderRecord rows
    // below reflect a real fill, not a still-resting order. The limit price
    // itself is the recorded entry price (no real fill-price readback exists
    // anywhere in this codebase's broker layer -- see placeOrder's own
    // referencePrice convention for market fills).
    result = { ...result, status: "filled", filledPrice: entryPrice, filledAt: new Date() };
  }

  const fillPrice = result.filledPrice ?? entryPrice;

  // Shift stop/target to the real fill (2026-08-17, operator request): the
  // risk engine sizes both around the theoretical `entryPrice` it scored the
  // setup at, but a real fill can land at a different price (see
  // BrowserControlBroker.readRealFillPrice). Shifting both by the same
  // signed offset the fill differed from the theoretical price preserves
  // the exact entry-to-stop/target DISTANCE the risk engine sized, just
  // anchored to what was actually filled instead of what was scored.
  // Operator's own example: theoretical entry 30000, SL 29995, TP 30010; a
  // real fill at 30003 (+3 offset) becomes SL 29998, TP 30013 -- same 5pt/
  // 10pt distances, anchored to the real fill. A zero offset (SimulatedBroker,
  // or a real fill that happened to land exactly on the theoretical price)
  // is a no-op below.
  const fillOffset = fillPrice.minus(entryPrice);
  const shiftedStopPrice = assessment.stopPrice ? assessment.stopPrice.plus(fillOffset) : null;
  const shiftedTakeProfitPrice = assessment.takeProfitPrice ? assessment.takeProfitPrice.plus(fillOffset) : null;
  if (!fillOffset.isZero()) {
    logger.info(
      {
        symbol: signal.symbol,
        entryPrice: entryPrice.toString(),
        fillPrice: fillPrice.toString(),
        fillOffset: fillOffset.toString(),
        originalStopPrice: assessment.stopPrice?.toString(),
        shiftedStopPrice: shiftedStopPrice?.toString(),
        originalTakeProfitPrice: assessment.takeProfitPrice?.toString(),
        shiftedTakeProfitPrice: shiftedTakeProfitPrice?.toString(),
      },
      "stop_target_shifted_to_real_fill"
    );
  }

  const trade = await prisma.trade.create({
    data: {
      accountId,
      symbol: signal.symbol,
      strategyId: signal.strategyId,
      side: signal.side,
      quantity: assessment.quantity,
      entryTime,
      entryPrice: fillPrice.toString(),
      stopPrice: shiftedStopPrice!.toString(),
      takeProfitPrice: shiftedTakeProfitPrice?.toString(),
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
      orderType: orderRequest.orderType,
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
