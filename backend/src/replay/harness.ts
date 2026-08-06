/**
 * The replay loop.
 *
 * Walks historical bars in strict chronological order, calls decideOnBar at
 * each close, and resolves open positions against subsequent bars using YOUR
 * OWN evaluateHypotheticalOutcome convention (stop wins a same-bar tie).
 *
 * Deliberately NOT reusing SimulatedBroker: that one is driven by live ticks
 * and prisma. The fill rules here must match SimulatedBroker.evaluateBar
 * exactly — if you change one, change both, and there is a test for that in
 * the plan (Phase 1, step 5).
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import { getInstrument } from "../marketData/instruments.js";
import { DEFAULT_SLIPPAGE_TICKS } from "../brokers/simulatedBroker.js";
import { decideOnBar } from "./decisionCore.js";
import { computeReplayMetrics } from "./metrics.js";
import type { ReplayDecisionContext } from "./replayDecisionContext.js";
import type {
  ReplayConfig, ReplayResult, ReplayTrade, BarDecision,
} from "./types.js";

interface OpenReplayPosition {
  symbol: string;
  strategyId: string;
  side: "long" | "short";
  representativeVersion: ReplayTrade["representativeVersion"];
  entryTime: Date;
  entryPrice: Decimal;
  stopPrice: Decimal;
  takeProfitPrice: Decimal;
  trailTicks: number | null;
  quantity: number;
  degraded: string[];
  /** Best price reached so far — ratchets the trail. See updateTrailingStop. */
  peakFavorable: Decimal;
  /** Has the trail ever improved on the original stop? Reporting only (exitReason "trail" vs "stop") — the hit-check always uses the live p.stopPrice regardless. */
  trailed: boolean;
}

export async function runReplay(
  config: ReplayConfig,
  ctx: ReplayDecisionContext,
  barsBySymbol: Map<string, OhlcBar[]>,
): Promise<ReplayResult> {
  const trades: ReplayTrade[] = [];
  const decisions: BarDecision[] = [];
  const equityCurve: Array<{ time: Date; equity: number }> = [];
  const open = new Map<string, OpenReplayPosition>();

  // Kept alongside ctx's own internal equity bookkeeping (see
  // ReplayDecisionContext.recordTradeClosed) rather than reading it back out
  // -- this one is for ReplayResult's reporting (equityCurve/metrics), that
  // one feeds RiskEngine.assessNewTrade's circuit-breaker checks. Both are
  // updated from the same pnl at the same point below, so they never drift.
  let equity = config.startingEquity;

  // Live's kill switch, once tripped, blocks NEW entries account-wide until
  // an operator manually clears it (getSystemState().killSwitch, checked in
  // onNewBar) -- open positions still get managed regardless (manageOpenTrades
  // doesn't check it). Mirrored here: once set, step 2 below is skipped for
  // every symbol on every later bar, but step 1 (resolving existing open
  // positions) keeps running.
  let killSwitchTrippedAt: Date | null = null;

  // Merge all symbols into one time-ordered stream. Cross-symbol ordering
  // matters: account-level circuit breakers and daily-loss limits are shared,
  // so processing ES fully then NQ fully would give the wrong answer.
  const stream = mergeChronological(barsBySymbol);

  for (const { symbol, bar, index } of stream) {
    if (bar.time < config.from || bar.time > config.to) continue;
    if (index < config.warmupBars) continue;

    // Day-rollover must see equity as it stood at the end of the PREVIOUS
    // bar -- called before anything below can change it this bar.
    ctx.advanceTo(bar.time);
    // Updated for every symbol's every bar (not just ones with an open
    // position) so mark-to-market always has a recent price for whichever
    // OTHER symbol might be open when a different symbol's decision runs.
    ctx.updateLastPrice(symbol, new Decimal(bar.close));

    const instrument = getInstrument(symbol);

    // ---- 1. Resolve any open position against THIS bar, before deciding.
    //         Order matters: an exit frees capital and risk budget for the
    //         same bar's entry decision, exactly as live does in
    //         manageOpenTrades -> evaluateNewSignals.
    const position = open.get(symbol);
    if (position) {
      const exit = resolveAgainstBar(position, bar, instrument.tickSize);
      if (exit) {
        const pnl = realizedPnl(position, exit.price, instrument.pointValue, instrument.tickSize, config.commissionPerContractPerSide ?? 0);
        equity += pnl;
        ctx.recordTradeClosed(pnl);
        ctx.markClosed(symbol);
        trades.push({
          symbol, strategyId: position.strategyId, side: position.side,
          representativeVersion: position.representativeVersion,
          entryTime: position.entryTime, entryPrice: position.entryPrice.toNumber(),
          stopPrice: position.stopPrice.toNumber(),
          takeProfitPrice: position.takeProfitPrice.toNumber(),
          quantity: position.quantity,
          exitTime: bar.time, exitPrice: exit.price.toNumber(), exitReason: exit.reason,
          rMultiple: rMultiple(position, exit.price),
          pnl, degraded: position.degraded,
        });
        open.delete(symbol);
        equityCurve.push({ time: bar.time, equity });
      }
    }

    // ---- 2. Decide on this bar's close (skipped once the kill switch has
    //         tripped -- see killSwitchTrippedAt above).
    //         decideOnBar returns one entry per strategy actually attempted
    //         this bar (evaluateNewSignals tries each in turn until one
    //         executes) -- record all of them, but only the first approved
    //         one (if any) can open a position, matching live's short-circuit.
    const barDecisions = killSwitchTrippedAt
      ? []
      : await decideOnBar({ ctx, symbol, barTime: bar.time, closePrice: new Decimal(bar.close) });
    for (const d of barDecisions) decisions.push(d);
    const decision = barDecisions.find((d) => d.plan?.approved && d.signal);
    const tripped = barDecisions.find((d) => d.plan?.tripKillSwitch);
    if (tripped && !killSwitchTrippedAt) killSwitchTrippedAt = bar.time;

    // ---- 3. Open a position if approved.
    //         Entry fills at the NEXT bar's open, not this close. This is the
    //         single most common backtest self-deception and the reason your
    //         live results would otherwise never match. Live cannot act on a
    //         close it has not seen yet.
    if (decision?.plan?.approved && decision.signal && !open.has(symbol)) {
      const next = nextBar(barsBySymbol.get(symbol)!, index);
      if (next) {
        const fill = new Decimal(next.open);
        ctx.markOpen(symbol, { side: decision.signal.side, entryPrice: fill, quantity: decision.plan.quantity, pointValue: instrument.pointValue });
        ctx.recordTradeOpened();
        open.set(symbol, {
          symbol,
          strategyId: decision.signal.strategyId,
          side: decision.signal.side,
          representativeVersion: decision.consensus.representativeVersion,
          entryTime: next.time,
          entryPrice: fill,
          stopPrice: decision.plan.stopPrice!,
          takeProfitPrice: decision.plan.takeProfitPrice!,
          trailTicks: decision.plan.trailTicks,
          quantity: decision.plan.quantity,
          degraded: decision.degraded,
          peakFavorable: fill,
          trailed: false,
        });
      }
    }
  }

  const degradationRate =
    decisions.length === 0 ? 0 : decisions.filter((d) => d.degraded.length > 0).length / decisions.length;

  return {
    config, trades, decisions, equityCurve,
    metrics: computeReplayMetrics(trades, equityCurve, config.startingEquity),
    degradationRate,
    killSwitchTrippedAt,
  };
}

/**
 * Same-bar resolution. Mirrors analytics/outcomeSimulation.ts:
 * if a bar's range could have hit both stop and target, assume the STOP hit
 * first. Pessimistic, and the only defensible choice without tick data.
 */
function resolveAgainstBar(
  p: OpenReplayPosition,
  bar: OhlcBar,
  tickSize: Decimal,
): { price: Decimal; reason: ReplayTrade["exitReason"] } | null {
  const high = new Decimal(bar.high);
  const low = new Decimal(bar.low);

  const hitStop = p.side === "long" ? low.lte(p.stopPrice) : high.gte(p.stopPrice);
  if (hitStop) return { price: p.stopPrice, reason: p.trailed ? "trail" : "stop" };

  const hitTarget = p.side === "long" ? high.gte(p.takeProfitPrice) : low.lte(p.takeProfitPrice);
  if (hitTarget) return { price: p.takeProfitPrice, reason: "target" };

  updateTrailingStop(p, bar, tickSize);
  return null;
}

/**
 * Trailing stop, matching SimulatedBroker.updateTrailingStop
 * (brokers/simulatedBroker.ts) — the paper-trading path, which is what
 * actually produces the Trade rows in this system today ("paper mode is the
 * norm," per CLAUDE.md). This is NOT the live browser-controlled broker's
 * mechanism (a one-shot fixed TRAILING_STOP_DISTANCE_TICKS order gated at
 * TRAILING_STOP_ACTIVATION_FRACTION, placed once in engine/loop.ts's
 * activateTrailingStop and then owned entirely by the broker) — an earlier
 * version of this function modeled that one instead, which is the wrong
 * mechanism for what this harness needs to validate against. Confirmed by
 * reading both call sites directly (2026-08-01).
 *
 * SimulatedBroker's real trail has no activation threshold at all: it
 * ratchets a highestFavorable price and moves the stop by trailTicks (the
 * chandelier-ATR distance from computeInitialStop, carried on the position
 * as p.trailTicks) on every price update, starting from the bar right after
 * entry. It also runs off single tick prices (onPriceTick, ~5-10s cadence),
 * not bar high/low — using this bar's high/low as the ratchet input is the
 * best available proxy without tick data (see CLAUDE.md's binding
 * constraint: 5-minute Yahoo bars).
 *
 * FIDELITY WARNING: replay only sees 5-minute OHLC and cannot know whether
 * the bar's high or its low came first. resolveAgainstBar checks a hit
 * against the stop as it stood BEFORE this bar's ratchet — i.e. assumes the
 * adverse extreme could have happened before the favorable one — matching
 * outcomeSimulation's same-bar-tie house rule instead of resolving the two
 * at the trailed level from the same bar's ratchet.
 */
function updateTrailingStop(p: OpenReplayPosition, bar: OhlcBar, tickSize: Decimal): void {
  const high = new Decimal(bar.high);
  const low = new Decimal(bar.low);

  p.peakFavorable = p.side === "long"
    ? Decimal.max(p.peakFavorable, high)
    : Decimal.min(p.peakFavorable, low);

  // trailTicks is guaranteed set whenever a position is open: it flows from
  // computeInitialStop (always >= 1) through an approved RiskEngine
  // assessment, and only approved plans ever open a position (see runReplay).
  const trailDistance = tickSize.times(p.trailTicks!);
  const trailed = p.side === "long"
    ? p.peakFavorable.minus(trailDistance)
    : p.peakFavorable.plus(trailDistance);

  // A trailing stop only ever moves in the trade's favor.
  const improved = p.side === "long" ? trailed.gt(p.stopPrice) : trailed.lt(p.stopPrice);
  if (improved) {
    p.stopPrice = trailed;
    p.trailed = true;
  }
}

function realizedPnl(
  p: OpenReplayPosition,
  exitPrice: Decimal,
  pointValue: Decimal,
  tickSize: Decimal,
  commissionPerContractPerSide: number,
): number {
  const move = p.side === "long" ? exitPrice.minus(p.entryPrice) : p.entryPrice.minus(exitPrice);
  const gross = move.times(pointValue).times(p.quantity);

  // One tick of slippage per side (entry + exit) -- the same assumption
  // SimulatedBroker.placeOrder already makes for every live paper fill (see
  // DEFAULT_SLIPPAGE_TICKS), not a separately-invented number for replay.
  const slippageCost = tickSize.times(DEFAULT_SLIPPAGE_TICKS).times(2).times(pointValue).times(p.quantity);

  // See ReplayConfig.commissionPerContractPerSide's comment -- defaults to 0
  // (understates real P&L) until the real rate is supplied.
  const commissionCost = new Decimal(commissionPerContractPerSide).times(2).times(p.quantity);

  return gross.minus(slippageCost).minus(commissionCost).toNumber();
}

function rMultiple(p: OpenReplayPosition, exitPrice: Decimal): number {
  const risk = p.entryPrice.minus(p.stopPrice).abs();
  if (risk.lte(0)) return 0;
  const move = p.side === "long" ? exitPrice.minus(p.entryPrice) : p.entryPrice.minus(exitPrice);
  return move.dividedBy(risk).toNumber();
}

function nextBar(bars: OhlcBar[], index: number): OhlcBar | null {
  return index + 1 < bars.length ? bars[index + 1]! : null;
}

function* mergeChronological(
  barsBySymbol: Map<string, OhlcBar[]>,
): Generator<{ symbol: string; bar: OhlcBar; index: number }> {
  const all: Array<{ symbol: string; bar: OhlcBar; index: number }> = [];
  for (const [symbol, bars] of barsBySymbol) {
    bars.forEach((bar, index) => all.push({ symbol, bar, index }));
  }
  all.sort((a, b) => a.bar.time.getTime() - b.bar.time.getTime());
  yield* all;
}
