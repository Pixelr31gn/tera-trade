/**
 * The orchestration loop: new bar -> manage open trades -> evaluate new signals.
 *
 * This is the one place that wires marketData -> regime -> news -> strategy
 * -> scoring -> risk -> execution -> explanation together. Everything above
 * it is a pure, independently-testable module; this is the glue.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { BrokerKind, getSettings, TradingMode } from "../core/config.js";
import type { BrokerClient, ClosedSimTrade } from "../brokers/types.js";
import { SimulatedBroker } from "../brokers/simulatedBroker.js";
import { computeAccountEquity, computeAccountRiskState, recordEquityPoint } from "./accounting.js";
import { ensureDefaultAccount, loadRecentBars } from "./bootstrap.js";
import { classifySession } from "../analytics/session.js";
import { getDailyTrend } from "./dailyTrendCache.js";
import { getHigherTimeframeTrends } from "./timeframeTrendCache.js";
import { getFixedTargetEdge } from "./fixedTargetEdgeCache.js";
import { getLatestOrderFlowSnapshot } from "./liveOrderFlowCache.js";
import { getOpeningRangeStats } from "./openingRangeCache.js";
import { explainKillSwitch, explainRiskRejection, explainScore, explainTradeExit } from "../explain/engine.js";
import { executeIfApproved } from "../execution/engine.js";
import { getSystemState, tripKillSwitch } from "../execution/mode.js";
import { getInstrument, type InstrumentSpec } from "../marketData/instruments.js";
import { getNewsRiskStatus, type NewsRiskStatus } from "../news/risk.js";
import { classifyRegime } from "../regime/classifier.js";
import type { RegimeResult } from "../regime/classifier.js";
import { atr as computeAtr, type OhlcBar } from "../regime/indicators.js";
import { computeInitialStop, RiskEngine, type RiskLimitsConfig } from "../risk/index.js";
import { buildSetupFeatures, type SetupFeatures } from "../scoring/features.js";
import { evaluateSetup, type GatedScore } from "../scoring/gate.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import { ALL_STRATEGIES } from "../strategy/index.js";
import type { Signal } from "../strategy/types.js";
import { ACTIVE_INSTRUMENTS } from "../marketData/instruments.js";
import type { Account, Trade } from "@prisma/client";

// v1, v2, v3 -- all rule-based/deterministic -- are the active voters,
// shadow-scored on every signal so their performance stays directly
// comparable. v4 (an independently ML-trained model, see scoring/
// training.ts) was tried 2026-07-15 and removed the same day at the
// operator's request -- its black-box, unproven scoring wasn't trusted
// enough for live money. The training pipeline itself is left in place
// (dormant, not deleted) in case it's revisited later; gate.ts no longer
// invokes it for any version. v3 runs last so v1/v2's results are already
// available for its own internal v1v2Override (see gate.ts) -- unrelated to
// the aggregate consensus rule below, which reads all three independently.
const STRATEGY_VERSIONS: StrategyVersion[] = ["v1", "v2", "v3"];

// Both paper AND live take a trade when at least 2 of the 3 versions'
// probabilities individually clear the score threshold (65%, see
// core/config.ts's minScoreThreshold) -- a straight majority vote on the raw
// score (2026-07-16, operator request, replacing the previous average/
// v3-standalone mechanism: a setup where v1 and v3 both independently scored
// it above 65% was being vetoed because v2's disagreement dragged the
// three-way average under 61%, even though 2 of 3 independent models liked
// it on its own merits).
// Preference order for which version's Score row/explanation represents a
// consensus trade -- richest factor set first, then the others.
const CONSENSUS_REPRESENTATIVE_ORDER: StrategyVersion[] = ["v3", "v2", "v1"];

interface ConsensusDecision {
  taken: boolean;
  representativeVersion: StrategyVersion | null;
  averageProbability: number;
  summary: string;
}

export function determineConsensus(gatedByVersion: Map<StrategyVersion, GatedScore>): ConsensusDecision {
  const minScoreThreshold = getSettings().minScoreThreshold;
  const probabilities = STRATEGY_VERSIONS.map((v) => gatedByVersion.get(v)!.probability);
  const averageProbability = probabilities.reduce((a, b) => a + b, 0) / probabilities.length;
  const clearingVersions = STRATEGY_VERSIONS.filter((v) => gatedByVersion.get(v)!.probability >= minScoreThreshold);
  const taken = clearingVersions.length >= 2;

  const takenVersions = STRATEGY_VERSIONS.filter((v) => gatedByVersion.get(v)!.decision === "taken");
  // Prefer a version that itself agrees ("taken") for the most meaningful
  // representative explanation. v1/v2's own "taken" decision is exactly
  // "probability >= threshold" (see scoring/gate.ts), so any version counted
  // in clearingVersions is also in takenVersions except possibly v3 (whose
  // own decision can additionally be blocked by its directional-conviction
  // margin check even with probability >= threshold) -- since at least 2 of
  // 3 versions clear to reach `taken` at all, at least one of them is
  // guaranteed to be v1 or v2, so takenVersions is never empty here; the
  // fallback below is defensive only.
  const representativeVersion = taken ? (CONSENSUS_REPRESENTATIVE_ORDER.find((v) => takenVersions.includes(v)) ?? CONSENSUS_REPRESENTATIVE_ORDER[0]!) : null;

  const summary = `${clearingVersions.length}/3 versions >= ${Math.round(minScoreThreshold * 100)}% (avg=${Math.round(averageProbability * 100)}%): ${STRATEGY_VERSIONS.map((v) => {
    const g = gatedByVersion.get(v)!;
    return `${v}=${g.probability >= minScoreThreshold ? "clears" : "below"} (${Math.round(g.probability * 100)}%)`;
  }).join(", ")}`;

  return { taken, representativeVersion, averageProbability, summary };
}

// Continuous-scan setups (see scanSymbolContinuously) have no detected chart
// pattern behind them -- unlike a real strategy signal, they're a bar-level
// directional read taken unconditionally on a timer. That earns a stricter,
// standalone-conviction bar rather than the plain majority vote above: at
// least one version must show real standout confidence (>=70%), and neither
// of the other two can be meaningfully against it (each >=50%) -- 2026-07-16
// operator request, made executable for the first time (previously v3-only
// and purely observational, never reaching risk assessment or execution).
const CONTINUOUS_SCAN_STANDOUT_THRESHOLD = 0.7;
const CONTINUOUS_SCAN_FLOOR_THRESHOLD = 0.5;

export function determineContinuousScanConsensus(gatedByVersion: Map<StrategyVersion, GatedScore>): ConsensusDecision {
  const probabilities = STRATEGY_VERSIONS.map((v) => gatedByVersion.get(v)!.probability);
  const averageProbability = probabilities.reduce((a, b) => a + b, 0) / probabilities.length;
  const minProbability = Math.min(...probabilities);
  const maxProbability = Math.max(...probabilities);
  const taken = minProbability >= CONTINUOUS_SCAN_FLOOR_THRESHOLD && maxProbability >= CONTINUOUS_SCAN_STANDOUT_THRESHOLD;

  // Same representative-selection shape as determineConsensus: prefer a
  // version whose own decision is "taken"; the standout version's raw
  // probability can clear 70% while its own decision still reads
  // skipped_score (v3's directional-conviction margin can fail even with a
  // high raw score), so takenVersions can in principle be empty here even
  // when taken=true -- the CONSENSUS_REPRESENTATIVE_ORDER[0] fallback below
  // covers that case.
  const takenVersions = STRATEGY_VERSIONS.filter((v) => gatedByVersion.get(v)!.decision === "taken");
  const representativeVersion = taken ? (CONSENSUS_REPRESENTATIVE_ORDER.find((v) => takenVersions.includes(v)) ?? CONSENSUS_REPRESENTATIVE_ORDER[0]!) : null;

  const summary = `standout ${Math.round(maxProbability * 100)}%, floor ${Math.round(minProbability * 100)}% (avg=${Math.round(averageProbability * 100)}%): ${STRATEGY_VERSIONS.map((v) => `${v}=${Math.round(gatedByVersion.get(v)!.probability * 100)}%`).join(", ")}`;

  return { taken, representativeVersion, averageProbability, summary };
}

const logger = childLogger("engineLoop");

const MIN_BARS_FOR_REGIME = 120;

// strategyId markers for TradingEngine.runContinuousScan's rows -- exported
// so callers (e.g. the actionable-recommendations endpoint) can exclude
// them: they're a running informational read, not a real strategy-detected
// setup meant to be manually acted on.
export const CONTINUOUS_SCAN_STRATEGY_IDS = ["continuous_v3_scan_long", "continuous_v3_scan_short"] as const;

// In-memory MAE/MFE tracking, keyed by trade id. Reset on process restart --
// acceptable for Phase 0 (single-process engine); a durable version would
// persist a running high/low alongside the trade row on every bar.
const tradeExcursion = new Map<number, { mfe: Decimal; mae: Decimal }>();

// Price ticks land every ~5-10s (browser watch), and onNewBar used to write
// an equity_curve row on every single one -- the paper account alone
// accumulated 7,500+ rows in about a day, which is far more resolution than
// any chart or Sharpe/drawdown calculation needs and was directly
// responsible for /api/performance/summary and the dashboard's equity chart
// getting slower over time as the table grew. Throttled to at most one
// recorded point per account per this interval; the DB still keeps a
// perfectly good equity history, just at a sane granularity.
const EQUITY_POINT_MIN_INTERVAL_MS = 30_000;
const lastEquityPointAt = new Map<number, number>();

// scanSymbolContinuously runs every 15s (see index.ts) but the underlying
// 1-minute bar it scores usually hasn't changed between consecutive ticks --
// confirmed live: the exact same probability was being persisted 3-4 times
// in a row before the bar actually rolled over, tripling the Score writes
// for no new information. Keyed by symbol, tracking the last bar timestamp
// actually scored so a tick gets skipped entirely (no DB write, no recompute)
// when nothing new has happened since.
const lastContinuousScanBarTime = new Map<string, number>();

export type EventSink = (event: Record<string, unknown>) => Promise<void>;

export class TradingEngine {
  private riskEngine = new RiskEngine();

  // Both brokers are held simultaneously (not just whichever one BROKER_KIND
  // happened to be at process startup) so a mode switch between paper and
  // live is instant and self-service from the UI/API -- no restart, no env
  // edit. Previously the engine was constructed with exactly one broker for
  // its whole lifetime, so switching to PAPER while BROKER_KIND=browser_control
  // (the normal live-trading config) was structurally impossible without
  // restarting the process with a different env var (2026-07-15 operator
  // report: "I shouldn't have to come into this console and code it").
  // liveBroker is null when no real broker is configured/connected --
  // LIVE mode is simply unavailable in that case (see brokerForMode).
  constructor(
    private simulatedBroker: SimulatedBroker,
    private liveBroker: BrokerClient | null,
    private liveBrokerKind: BrokerKind | null,
    private eventSink?: EventSink
  ) {}

  /** Which broker actually places a NEW order right now, based on the current mode. */
  private brokerForMode(mode: TradingMode): BrokerClient {
    if (mode === TradingMode.LIVE) {
      if (!this.liveBroker) throw new Error("cannot execute in LIVE mode: no live broker (ProjectX/browser-control) is connected");
      return this.liveBroker;
    }
    return this.simulatedBroker; // PAPER, and ANALYSIS_ONLY (which never actually calls placeOrder)
  }

  private brokerKindForMode(mode: TradingMode): BrokerKind {
    return mode === TradingMode.LIVE ? this.liveBrokerKind! : BrokerKind.SIMULATED;
  }

  /**
   * Which broker manages an EXISTING open trade -- driven by the broker it
   * was actually opened under (Trade.brokerKind), not the system's current
   * mode. Switching modes with a live position still open must keep
   * managing that position with the live broker, not silently start
   * treating it as a simulated one just because the mode changed.
   */
  private brokerForTrade(trade: Trade): BrokerClient {
    if (trade.brokerKind === BrokerKind.SIMULATED) return this.simulatedBroker;
    if (!this.liveBroker) throw new Error(`trade #${trade.id} needs broker kind "${trade.brokerKind}" but none is currently connected`);
    return this.liveBroker;
  }

  private async emit(event: Record<string, unknown>): Promise<void> {
    if (this.eventSink) await this.eventSink(event);
  }

  // Fast path -- called on every raw price tick (~5-10s from the browser
  // watcher), for responsive stop/target monitoring and live equity
  // tracking. Deliberately does NOT evaluate new strategy signals: a
  // Donchian/EMA/Bollinger check needs a genuinely completed bar, not every
  // sub-minute wiggle -- see onNewBar below and marketData/
  // minuteBarAggregator.ts. Running signal evaluation on every tick was the
  // actual cause of a 19% real win rate: the strategies were unknowingly
  // trading ~20-*tick* (100-200 second) breakouts instead of 20-*minute*
  // ones, with a median trade duration of 25 seconds.
  async onPriceTick(symbol: string, time: Date, price: Decimal): Promise<void> {
    const account = await ensureDefaultAccount();
    const systemState = await getSystemState();

    await this.manageOpenTrades(account, symbol, time, price, price, price);

    if (systemState.killSwitch) {
      await this.emit({ type: "kill_switch_active", reason: systemState.killSwitchReason });
    }

    const equity = await computeAccountEquity(account, new Map([[symbol, price]]));
    const now = Date.now();
    const lastAt = lastEquityPointAt.get(account.id) ?? 0;
    if (now - lastAt >= EQUITY_POINT_MIN_INTERVAL_MS) {
      lastEquityPointAt.set(account.id, now);
      await recordEquityPoint(account.id, equity, new Decimal(account.startingBalance.toString()), time, this.brokerKindForMode(systemState.mode as TradingMode));
    }
    await this.emit({ type: "equity_update", accountId: account.id, equity: equity.toString(), time: time.toISOString() });
  }

  // Called only when a genuinely new, completed bar is available (once per
  // real minute for the browser-tick path -- see marketData/
  // minuteBarAggregator.ts; once per poll for the non-browser LiveBarPoller
  // path, since each of its polls already is a complete bar). This is the
  // only place strategies see new data -- onPriceTick above handles
  // per-tick monitoring so this doesn't need to duplicate it.
  async onNewBar(symbol: string, barTime: Date, o: Decimal, h: Decimal, l: Decimal, c: Decimal, v: Decimal): Promise<void> {
    const account = await ensureDefaultAccount();
    const systemState = await getSystemState();
    const mode = systemState.mode as TradingMode;

    if (!systemState.killSwitch) {
      await this.evaluateNewSignals(account, mode, symbol, barTime, c);
    }
  }

  private async manageOpenTrades(account: Account, symbol: string, barTime: Date, h: Decimal, l: Decimal, c: Decimal): Promise<void> {
    const openTrade = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" } });
    if (!openTrade) return;
    this.trackExcursion(openTrade, h, l);

    if (openTrade.brokerKind !== BrokerKind.SIMULATED) {
      await this.manageLiveOpenTrade(account, openTrade, symbol, barTime, h, l);
      return;
    }

    const brokerAccountId = (await this.simulatedBroker.getAccounts())[0]!.accountId;
    this.simulatedBroker.updateTrailingStop(brokerAccountId, symbol, c);

    // The hit check below is driven by the trade row's own persisted
    // stopPrice/takeProfitPrice, not SimulatedBroker.evaluateBar -- its
    // brackets/positions are plain in-memory Maps, never persisted, so a
    // fresh broker instance (any process restart) has zero memory of ever
    // opening this position. Concretely found this way: trade #63 (NQ, long)
    // sat open for 71+ hours across many dev-server restarts while price
    // fell 500+ points past its stop, because evaluateBar always returned
    // null for a bracket it never had -- and per evaluateNewSignals below,
    // an open position also blocks all new signals on that symbol, so NQ
    // silently stopped generating any trades at all for those 3 days too.
    // If the broker instance *does* still remember this position (the
    // common case -- no restart happened since entry), pull its trailed
    // stop and keep the DB row in sync so the dashboard reflects it.
    const brokerStop = this.simulatedBroker.getBracketStopPrice(brokerAccountId, symbol);
    if (brokerStop && !brokerStop.eq(openTrade.stopPrice.toString())) {
      await prisma.trade.update({ where: { id: openTrade.id }, data: { stopPrice: brokerStop.toString() } });
    }
    const stopPrice = brokerStop ?? new Decimal(openTrade.stopPrice.toString());
    const takeProfitPrice = openTrade.takeProfitPrice ? new Decimal(openTrade.takeProfitPrice.toString()) : null;

    let hitStop: boolean;
    let hitTarget: boolean;
    if (openTrade.side === "long") {
      hitStop = l.lte(stopPrice);
      hitTarget = takeProfitPrice !== null && h.gte(takeProfitPrice);
    } else {
      hitStop = h.gte(stopPrice);
      hitTarget = takeProfitPrice !== null && l.lte(takeProfitPrice);
    }
    if (!hitStop && !hitTarget) return;

    const exitReason: "stop" | "target" = hitStop ? "stop" : "target";
    const exitPrice = hitStop ? stopPrice : takeProfitPrice!;
    await this.simulatedBroker.closePosition(brokerAccountId, symbol, exitPrice); // no-op if the broker never had this position (e.g. post-restart)
    await this.closeTrade(account, { symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: undefined });
  }

  // Live trades were previously never checked here at all ("live broker
  // manages its own brackets server-side") -- true in principle (TopstepX's
  // own bracket order is what actually closes the position), but this app
  // had zero mechanism to learn *when* that happened, so a trade row stayed
  // "open" forever after a real close, permanently blocking new signals on
  // that symbol via evaluateNewSignals' hasOpen check (confirmed live,
  // 2026-07-15: trade #122 sat "open" for hours after TopstepX's bracket had
  // already closed it for a real, positive P&L). Now: once price crosses the
  // stop/target level in our own bar data, confirm what's actually true on
  // the broker before acting, rather than assuming either "it already closed
  // itself" or "it needs closing":
  //   - confirmed flat (bracket did its job) -> just sync our record
  //   - confirmed still open (bracket failed to fire) -> this is the
  //     dangerous case from trade #121 (unprotected position past its
  //     intended exit) -- force-close it now
  //   - can't tell either way -> don't guess; log loudly for manual review
  private async manageLiveOpenTrade(account: Account, openTrade: Trade, symbol: string, barTime: Date, h: Decimal, l: Decimal): Promise<void> {
    const stopPrice = new Decimal(openTrade.stopPrice.toString());
    const takeProfitPrice = openTrade.takeProfitPrice ? new Decimal(openTrade.takeProfitPrice.toString()) : null;

    let hitStop: boolean;
    let hitTarget: boolean;
    if (openTrade.side === "long") {
      hitStop = l.lte(stopPrice);
      hitTarget = takeProfitPrice !== null && h.gte(takeProfitPrice);
    } else {
      hitStop = h.gte(stopPrice);
      hitTarget = takeProfitPrice !== null && l.lte(takeProfitPrice);
    }
    if (!hitStop && !hitTarget) return;

    const exitReason: "stop" | "target" = hitStop ? "stop" : "target";
    const exitPrice = hitStop ? stopPrice : takeProfitPrice!;
    const broker = this.brokerForTrade(openTrade);
    const brokerAccountId = (await broker.getAccounts())[0]!.accountId;

    const isFlat = await broker.isPositionFlat?.(symbol);

    if (isFlat === true) {
      // Exit price is our own configured stop/target, not a confirmed fill
      // (this app has no way yet to read back TopstepX's actual fill price)
      // -- labeled as an estimate in the explanation, same as the manual
      // trade #122 reconciliation this replaces.
      await this.closeTrade(account, { symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: "estimated_from_bracket" });
      logger.info({ symbol, tradeId: openTrade.id, exitReason, exitPrice: exitPrice.toString() }, "live_trade_closed_synced_from_broker");
    } else if (isFlat === false) {
      logger.error({ symbol, tradeId: openTrade.id, exitReason }, "live_bracket_failed_forcing_close");
      const closeResult = await broker.requestClosePosition?.(symbol);
      if (closeResult && closeResult.status !== "rejected") {
        await this.closeTrade(account, { symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: "forced_after_bracket_failure" });
      } else {
        logger.error({ symbol, tradeId: openTrade.id, error: closeResult?.error }, "live_forced_close_failed");
      }
    } else {
      logger.warn({ symbol, tradeId: openTrade.id, exitReason }, "live_trade_past_exit_position_state_unknown");
    }
  }

  private trackExcursion(trade: { id: number; side: string; entryPrice: unknown }, h: Decimal, l: Decimal): void {
    const entryPrice = new Decimal(trade.entryPrice as string);
    const direction = trade.side === "long" ? 1 : -1;
    const favorableExtreme = direction === 1 ? h : l;
    const adverseExtreme = direction === 1 ? l : h;
    const favorableMove = Decimal.max(0, favorableExtreme.minus(entryPrice).times(direction));
    const adverseMove = Decimal.max(0, entryPrice.minus(adverseExtreme).times(direction));

    const existing = tradeExcursion.get(trade.id) ?? { mfe: new Decimal(0), mae: new Decimal(0) };
    tradeExcursion.set(trade.id, { mfe: Decimal.max(existing.mfe, favorableMove), mae: Decimal.max(existing.mae, adverseMove) });
  }

  private async closeTrade(account: Account, closed: ClosedSimTrade): Promise<void> {
    const trade = await prisma.trade.findFirst({
      where: { accountId: account.id, symbol: closed.symbol, status: "open" },
      orderBy: { entryTime: "desc" },
    });
    if (!trade) return;

    const instrument = getInstrument(trade.symbol);
    const direction = trade.side === "long" ? 1 : -1;
    const pnl = closed.exitPrice.minus(trade.entryPrice.toString()).times(direction).times(instrument.pointValue).times(trade.quantity);

    const excursion = tradeExcursion.get(trade.id) ?? { mfe: new Decimal(0), mae: new Decimal(0) };
    tradeExcursion.delete(trade.id);

    const explanation = explainTradeExit(trade.symbol, trade.side, closed.exitReason, closed.exitPrice, pnl);
    // customTag on a live-broker close (see manageLiveOpenTrade) marks the
    // exit price/pnl as an estimate from our own configured stop/target, not
    // a confirmed broker fill -- surfaced here so it's never silently
    // presented as precise financial data.
    const tagNote =
      closed.customTag === "estimated_from_bracket"
        ? " [exit price is an ESTIMATE from the configured stop/target, not a confirmed fill -- TopstepX's own bracket order closed this position server-side]"
        : closed.customTag === "forced_after_bracket_failure"
          ? " [bracket failed to fire -- this app force-closed the position after price crossed the stop/target level]"
          : "";
    await prisma.trade.update({
      where: { id: trade.id },
      data: {
        exitTime: closed.exitTime,
        exitPrice: closed.exitPrice.toString(),
        exitReason: closed.exitReason,
        pnl: pnl.toString(),
        mae: excursion.mae.toString(),
        mfe: excursion.mfe.toString(),
        status: "closed",
        explanation: `${trade.explanation} ${explanation}${tagNote}`,
      },
    });

    await this.emit({ type: "trade_closed", tradeId: trade.id, symbol: trade.symbol, pnl: pnl.toString(), explanation });
  }

  // Shared by both the real-signal path (evaluateNewSignals) and continuous
  // scan (scanSymbolContinuously): shadow-scores one hypothetical setup under
  // all three strategy versions, persisting a Score row per version so their
  // performance stays directly comparable regardless of which path produced
  // the setup.
  private async scoreAllVersions(params: {
    features: SetupFeatures;
    bars: OhlcBar[];
    symbol: string;
    side: "long" | "short";
    strategyId: string;
    structureSwingPriceAtSignal: Decimal | null;
    signalKind: "breakout" | "reversal" | undefined;
    breakoutLevelPrice: Decimal | undefined;
    barTime: Date;
    closePrice: Decimal;
    atrValue: Decimal;
    riskRewardRatio: number | null;
  }): Promise<{ gatedByVersion: Map<StrategyVersion, GatedScore>; scoreIdByVersion: Map<StrategyVersion, number> }> {
    const { features, bars, symbol, side, strategyId, structureSwingPriceAtSignal, signalKind, breakoutLevelPrice, barTime, closePrice, atrValue, riskRewardRatio } = params;
    const settings = getSettings();
    const gatedByVersion = new Map<StrategyVersion, GatedScore>();
    const scoreIdByVersion = new Map<StrategyVersion, number>();
    for (const version of STRATEGY_VERSIONS) {
      // v3 runs last (see STRATEGY_VERSIONS order), so v1/v2's results are
      // already in gatedByVersion by the time it's v3's turn -- passed
      // through so v3 can hard-override to "taken" when both v1 and v2
      // already agreed (see gate.ts's v1v2Override).
      const gated = await evaluateSetup(
        features,
        version,
        version === "v3" ? { bars, v1Gated: gatedByVersion.get("v1"), v2Gated: gatedByVersion.get("v2"), signalKind } : undefined
      );
      const explanation = explainScore(symbol, side, gated, settings.minScoreThreshold);
      gatedByVersion.set(version, gated);

      const scoreRow = await prisma.score.create({
        data: {
          time: barTime, symbol, strategyId, side,
          probability: gated.probability.toString(), decision: gated.decision,
          features: JSON.parse(JSON.stringify(features)), explanation,
          session: features.session,
          strategyVersion: version,
          v3Bucket: gated.v3Bucket,
          // Denormalized for the session-performance/strategy-comparison
          // analytics queries -- see the schema comment on these columns.
          marketStructureLabel: features.marketStructureLabel,
          liquidityLabel: features.liquidityLabel,
          priceActionLabel: features.priceActionLabel,
          entryPriceAtSignal: closePrice.toString(),
          structureSwingPriceAtSignal: structureSwingPriceAtSignal?.toString(),
          atrAtSignal: atrValue.toString(),
          riskRewardRatio: riskRewardRatio?.toString(),
          signalKind: signalKind ?? null,
          breakoutLevelPrice: breakoutLevelPrice?.toString(),
        },
      });
      scoreIdByVersion.set(version, scoreRow.id);
      await this.emit({ type: "score", symbol, side, strategyVersion: version, probability: gated.probability, decision: gated.decision, explanation });
    }
    return { gatedByVersion, scoreIdByVersion };
  }

  // Shared consensus -> risk -> execution pipeline. Returns "consensus_not_reached"
  // or "risk_rejected" when the caller should keep trying other candidates for
  // the same bar; "kill_switch" or "executed" mean stop -- a kill switch trip
  // halts everything, and a risk-approved setup is the one and only position
  // this symbol gets this bar/tick regardless of whether the broker itself
  // filled it (assessment.approved already means it should have).
  private async attemptExecution(params: {
    consensus: ConsensusDecision;
    gatedByVersion: Map<StrategyVersion, GatedScore>;
    scoreIdByVersion: Map<StrategyVersion, number>;
    account: Account;
    mode: TradingMode;
    symbol: string;
    side: "long" | "short";
    strategyId: string;
    structureSwingPrice: Decimal | null;
    signalKind: "breakout" | "reversal";
    breakoutLevelPrice: Decimal | null;
    closePrice: Decimal;
    atrValue: Decimal;
    instrument: InstrumentSpec;
    regime: RegimeResult;
    newsStatus: NewsRiskStatus;
    bars: OhlcBar[];
    barTime: Date;
  }): Promise<{ outcome: "consensus_not_reached" | "risk_rejected" | "kill_switch" | "executed"; executed: boolean }> {
    const { consensus, gatedByVersion, scoreIdByVersion, account, mode, symbol, side, strategyId, structureSwingPrice, signalKind, breakoutLevelPrice, closePrice, atrValue, instrument, regime, newsStatus, bars, barTime } = params;

    if (!consensus.taken || !consensus.representativeVersion) {
      // Was worth persistently logging -- at least one version said "taken"
      // here, or this wouldn't be worth a log line at all, but consensus
      // wasn't reached. Previously this was only visible over the live
      // WebSocket feed, meaning it was untraceable after the fact -- exactly
      // the gap that made a real missed-signal report undiagnosable.
      if ([...gatedByVersion.values()].some((g) => g.decision === "taken")) {
        logger.info({ symbol, side, strategyId, mode, summary: consensus.summary }, "consensus_not_reached");
      }
      return { outcome: "consensus_not_reached", executed: false };
    }
    const decisionGated = gatedByVersion.get(consensus.representativeVersion)!;
    const decisionScoreId = scoreIdByVersion.get(consensus.representativeVersion) ?? null;
    const decisionExplanationPrefix = `CONSENSUS [${consensus.summary}]. `;
    logger.info({ symbol, side, strategyId, mode, summary: consensus.summary }, "consensus_reached");

    const settings = getSettings();
    const riskLimitsRow = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
    const limits: RiskLimitsConfig = {
      perTradeRiskPct: new Decimal(riskLimitsRow.perTradeRiskPct.toString()),
      maxDailyLossPct: new Decimal(riskLimitsRow.maxDailyLossPct.toString()),
      maxTrailingDrawdownPct: new Decimal(riskLimitsRow.maxTrailingDrawdownPct.toString()),
      maxConsecutiveLosses: riskLimitsRow.maxConsecutiveLosses,
      maxDailyTrades: riskLimitsRow.maxDailyTrades,
      maxPositionSize: riskLimitsRow.maxPositionSize,
      perTradeRiskDollars: riskLimitsRow.perTradeRiskDollars ? new Decimal(riskLimitsRow.perTradeRiskDollars.toString()) : null,
      perTradeProfitDollars: riskLimitsRow.perTradeProfitDollars ? new Decimal(riskLimitsRow.perTradeProfitDollars.toString()) : null,
      maxDailyLossDollars: riskLimitsRow.maxDailyLossDollars ? new Decimal(riskLimitsRow.maxDailyLossDollars.toString()) : null,
    };

    const equity = await computeAccountEquity(account, new Map([[symbol, closePrice]]));
    const accountState = await computeAccountRiskState(account, equity);

    const assessment = this.riskEngine.assessNewTrade({
      side, entryPrice: closePrice, atrValue,
      structureSwingPrice,
      signalKind, breakoutLevelPrice,
      accountState, limits,
      pointValue: instrument.pointValue, tickSize: instrument.tickSize, newsStatus, bars,
    });

    if (assessment.tripKillSwitch) {
      await tripKillSwitch(assessment.reason);
      logger.error({ symbol, side, reason: assessment.reason }, "kill_switch_tripped");
      await this.emit({ type: "kill_switch_tripped", reason: explainKillSwitch(assessment.reason) });
      return { outcome: "kill_switch", executed: false };
    }

    if (!assessment.approved) {
      const rejection = explainRiskRejection(symbol, side, assessment);
      // Same gap as consensus_not_reached above -- previously only
      // WebSocket-emitted, so a rejected setup that a user later noticed
      // (e.g. "the recommendation didn't turn into a position") was
      // untraceable once the moment had passed.
      logger.warn({ symbol, side, strategyId, reason: rejection }, "risk_rejected");
      await this.emit({ type: "risk_rejected", symbol, reason: rejection });
      return { outcome: "risk_rejected", executed: false };
    }

    const decisionExplanation = decisionExplanationPrefix + explainScore(symbol, side, decisionGated, settings.minScoreThreshold);
    const broker = this.brokerForMode(mode);
    const brokerAccountId = (await broker.getAccounts())[0]!.accountId;
    // executeIfApproved only ever reads signal.symbol/side/strategyId --
    // structureSwingPrice on this object is unused there (it already fed the
    // stop-plan computation via RiskEngine.assessNewTrade above), so a
    // placeholder satisfies the Signal type without affecting anything.
    const signalForExecution: Signal = {
      strategyId, symbol, side,
      structureSwingPrice: structureSwingPrice ?? closePrice,
      reason: strategyId,
      signalKind,
      breakoutLevelPrice: breakoutLevelPrice ?? undefined,
    };
    const result = await executeIfApproved(
      broker, this.brokerKindForMode(mode), mode, account.id, brokerAccountId, signalForExecution, decisionGated, assessment,
      closePrice, regime.trendLabel, regime.volLabel, decisionExplanation, barTime, decisionScoreId
    );
    await this.emit({ type: "execution", symbol, executed: result.executed, reason: result.reason, tradeId: result.tradeId });
    return { outcome: "executed", executed: result.executed };
  }

  private async evaluateNewSignals(account: Account, mode: TradingMode, symbol: string, barTime: Date, closePrice: Decimal): Promise<void> {
    const bars: OhlcBar[] = await loadRecentBars(symbol, 300);
    if (bars.length < MIN_BARS_FOR_REGIME) return;

    const regime = classifyRegime(bars);
    await prisma.regimeSnapshot.upsert({
      where: { time_symbol: { time: barTime, symbol } },
      update: { trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence.toString(), features: JSON.parse(JSON.stringify(regime.features)) },
      create: { time: barTime, symbol, trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence.toString(), features: JSON.parse(JSON.stringify(regime.features)) },
    });
    await this.emit({ type: "regime", symbol, trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence });

    // Skip generating new entries into a symbol that already has an open position.
    const hasOpen = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" }, select: { id: true } });
    if (hasOpen) return; // excursion tracking for this open position already happened in manageOpenTrades

    const newsStatus = await getNewsRiskStatus(barTime);
    const openingRangeStats = await getOpeningRangeStats(symbol);
    const [dailyTrend, higherTimeframeTrends] = await Promise.all([getDailyTrend(symbol), getHigherTimeframeTrends(symbol)]);
    const session = classifySession(barTime);

    for (const strategy of ALL_STRATEGIES) {
      const signal = strategy.generateSignal(symbol, bars);
      if (!signal) continue;

      // Direction-specific: a long setup cares about the historical odds the
      // *high* gets broken later; a short setup cares about the *low*.
      const openingRangeBreakoutProbability =
        signal.side === "long" ? openingRangeStats.probHighBroken : openingRangeStats.probLowBroken;

      // Only long setups are gated on this (see scoring/gate.ts) -- skip the
      // extra query entirely for shorts rather than computing an unused stat.
      const longTargetEdge = signal.side === "long" ? await getFixedTargetEdge(symbol, session, "long") : null;

      // ATR/instrument/stop-plan are version-independent (same underlying
      // market data) and computed once for *every* signal, taken or skipped --
      // a skipped setup still needs a hypothetical entry/stop/ATR on record so
      // the outcome evaluator can retrospectively simulate what would have
      // happened (see engine/outcomeEvaluator.ts). Computed before
      // buildSetupFeatures (not after, as before) so riskRewardRatio can be
      // fed into scoring as a real certainty factor, not just recorded
      // alongside it.
      const instrument = getInstrument(symbol);
      const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
      if (atrSeries.length === 0) continue;
      const atrValue = new Decimal(atrSeries[atrSeries.length - 1]!);
      const hypotheticalStopPlan = computeInitialStop(closePrice, signal.side, atrValue, signal.structureSwingPrice, { tickSize: instrument.tickSize });
      const riskRewardRatio = hypotheticalStopPlan.stopDistancePoints.gt(0)
        ? hypotheticalStopPlan.takeProfitPrice.minus(closePrice).abs().dividedBy(hypotheticalStopPlan.stopDistancePoints).toNumber()
        : null;

      const features = buildSetupFeatures(
        bars, symbol, signal.side, regime, barTime, newsStatus.inRiskWindow, newsStatus.minutesToEvent,
        null, openingRangeBreakoutProbability, openingRangeStats.sessionsAnalyzed,
        dailyTrend.trendLabel, dailyTrend.confidence,
        longTargetEdge?.winRate ?? null, longTargetEdge?.sampleSize ?? 0,
        riskRewardRatio, getLatestOrderFlowSnapshot(symbol), higherTimeframeTrends
      );

      // Shadow-score every signal under all three strategy versions in
      // parallel -- same features, same bar, same market conditions -- so
      // their hypothetical performance stays directly comparable.
      const { gatedByVersion, scoreIdByVersion } = await this.scoreAllVersions({
        features, bars, symbol, side: signal.side, strategyId: signal.strategyId,
        structureSwingPriceAtSignal: signal.structureSwingPrice, signalKind: signal.signalKind,
        breakoutLevelPrice: signal.breakoutLevelPrice, barTime, closePrice, atrValue, riskRewardRatio,
      });

      // Both paper and live require the majority-vote consensus above (a
      // deliberate change: 2026-07-14 introduced cross-version agreement at
      // all, 2026-07-16 replaced an average-based rule with this one so a
      // single strongly-disagreeing version can't veto two others' agreement).
      const consensus = determineConsensus(gatedByVersion);
      const result = await this.attemptExecution({
        consensus, gatedByVersion, scoreIdByVersion, account, mode, symbol, side: signal.side, strategyId: signal.strategyId,
        structureSwingPrice: signal.structureSwingPrice, signalKind: signal.signalKind, breakoutLevelPrice: signal.breakoutLevelPrice ?? null,
        closePrice, atrValue, instrument, regime, newsStatus, bars, barTime,
      });
      if (result.outcome === "consensus_not_reached" || result.outcome === "risk_rejected") continue;
      return; // one new position per symbol per bar (kill_switch or executed both stop here)
    }
  }

  // A real strategy signal (breakout/reversion/crossover) only fires on a
  // genuine technical trigger, so gaps of many minutes between "taken"
  // recommendations are normal and correct -- forcing execution-worthy
  // signals onto a fixed clock would mean trading a coin flip on a timer,
  // not a real setup. What a fixed cadence *is* right for is a running
  // "what does v3 currently think" read, independent of whether any
  // strategy actually triggered -- this runs on a timer (see index.ts) and
  // scores both hypothetical directions for every instrument. It is
  // strictly observational: it feeds the Recommendations feed and v3's
  // historical-adjustment learning data, and never reaches risk assessment
  // or execution (see api/routes/scores.ts's actionable-recommendations
  // endpoint, which is unaffected since it filters to real strategy IDs).
  async runContinuousScan(): Promise<void> {
    const settings = getSettings();
    // Each instrument's scan is fully independent (its own bars, caches, DB
    // rows) -- these used to run one at a time, so a full cycle across 4
    // symbols paid for 4x the DB round-trip latency in serial, and a cache
    // miss on any one of them stalled the rest behind it. Promise.allSettled
    // keeps the original per-symbol error isolation (one instrument failing
    // doesn't stop the others) while letting them actually run concurrently.
    const account = await ensureDefaultAccount();
    const systemState = await getSystemState();
    const mode = systemState.mode as TradingMode;
    const results = await Promise.allSettled(
      ACTIVE_INSTRUMENTS.map((spec) => this.scanSymbolContinuously(spec.symbol, account, mode))
    );
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        logger.warn({ symbol: ACTIVE_INSTRUMENTS[i]!.symbol, err: String(result.reason) }, "continuous_scan_failed");
      }
    });
  }

  private async scanSymbolContinuously(symbol: string, account: Account, mode: TradingMode): Promise<void> {
    const barTime = new Date();
    // None of these four depend on each other's result -- they were
    // previously awaited one at a time, paying for each one's DB round-trip
    // (or, on a cache miss, a genuinely expensive aggregate query) serially.
    const [bars, newsStatus, openingRangeStats, dailyTrend, higherTimeframeTrends] = await Promise.all([
      loadRecentBars(symbol, 300),
      getNewsRiskStatus(barTime),
      getOpeningRangeStats(symbol),
      getDailyTrend(symbol),
      getHigherTimeframeTrends(symbol),
    ]);
    if (bars.length < MIN_BARS_FOR_REGIME) return;

    const lastBar = bars[bars.length - 1]!;
    const lastBarTimeMs = lastBar.time.getTime();
    if (lastContinuousScanBarTime.get(symbol) === lastBarTimeMs) return; // nothing new since the last tick -- skip the recompute and the duplicate write
    lastContinuousScanBarTime.set(symbol, lastBarTimeMs);

    const closePrice = new Decimal(lastBar.close);

    const regime = classifyRegime(bars);
    const session = classifySession(barTime);
    const instrument = getInstrument(symbol);
    const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
    if (atrSeries.length === 0) return;
    const atrValue = new Decimal(atrSeries[atrSeries.length - 1]!);

    // Long and short are independent hypothetical reads over the same bars
    // -- scored concurrently (each writes its own Score rows, one per
    // version, distinct strategyId per side, so there's no shared mutable
    // state or write conflict between them). Execution is deliberately NOT
    // part of this Promise.all -- see below.
    const sideResults = await Promise.all(
      (["long", "short"] as const).map(async (side) => {
        const openingRangeBreakoutProbability = side === "long" ? openingRangeStats.probHighBroken : openingRangeStats.probLowBroken;
        const longTargetEdge = side === "long" ? await getFixedTargetEdge(symbol, session, "long") : null;

        const hypotheticalStopPlan = computeInitialStop(closePrice, side, atrValue, null, { tickSize: instrument.tickSize });
        const riskRewardRatio = hypotheticalStopPlan.stopDistancePoints.gt(0)
          ? hypotheticalStopPlan.takeProfitPrice.minus(closePrice).abs().dividedBy(hypotheticalStopPlan.stopDistancePoints).toNumber()
          : null;

        const features = buildSetupFeatures(
          bars, symbol, side, regime, barTime, newsStatus.inRiskWindow, newsStatus.minutesToEvent,
          null, openingRangeBreakoutProbability, openingRangeStats.sessionsAnalyzed,
          dailyTrend.trendLabel, dailyTrend.confidence,
          longTargetEdge?.winRate ?? null, longTargetEdge?.sampleSize ?? 0,
          riskRewardRatio, getLatestOrderFlowSnapshot(symbol), higherTimeframeTrends
        );

        const strategyId = side === "long" ? CONTINUOUS_SCAN_STRATEGY_IDS[0] : CONTINUOUS_SCAN_STRATEGY_IDS[1];
        // Scored under all three versions now (2026-07-16 operator request --
        // previously v3-only and purely observational). No detected chart
        // pattern backs this setup, so there's no real structureSwingPrice/
        // breakoutLevelPrice to record, and signalKind is decided at
        // execution time below (see determineContinuousScanConsensus).
        const { gatedByVersion, scoreIdByVersion } = await this.scoreAllVersions({
          features, bars, symbol, side, strategyId,
          structureSwingPriceAtSignal: null, signalKind: undefined, breakoutLevelPrice: undefined,
          barTime, closePrice, atrValue, riskRewardRatio,
        });

        return { side, strategyId, gatedByVersion, scoreIdByVersion };
      })
    );

    // Execution attempts are sequential (not Promise.all like the scoring
    // above), with a fresh open-position check immediately before each one --
    // guarantees at most one of {long, short} actually opens a position per
    // tick, and also catches a position the real-signal path opened
    // concurrently on the same symbol.
    for (const { side, strategyId, gatedByVersion, scoreIdByVersion } of sideResults) {
      const hasOpen = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" }, select: { id: true } });
      if (hasOpen) break;

      // Continuous-scan trades have no detected chart pattern, so
      // signalKind is generic "reversal" (the risk engine's "enter near a
      // real S/R level in the trade's favor" gate, not the breakout-specific
      // broken-level check) and structureSwingPrice/breakoutLevelPrice are
      // both null -- the stop plan falls back to pure ATR, same as this
      // path's hypothetical preview always has.
      const consensus = determineContinuousScanConsensus(gatedByVersion);
      const result = await this.attemptExecution({
        consensus, gatedByVersion, scoreIdByVersion, account, mode, symbol, side, strategyId,
        structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
        closePrice, atrValue, instrument, regime, newsStatus, bars, barTime,
      });
      if (result.outcome === "kill_switch") return;
    }
  }
}
