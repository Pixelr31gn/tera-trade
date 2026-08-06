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
import { AccountSource, BrokerKind, getSettings, TradingMode } from "../core/config.js";
import type { BrokerClient, ClosedSimTrade } from "../brokers/types.js";
import { SimulatedBroker } from "../brokers/simulatedBroker.js";
import { computeAccountEquity, computeAccountRiskState, recordEquityPoint } from "./accounting.js";
import { ensureAccountForBrokerId, ensureDefaultAccount, loadRecentBars } from "./bootstrap.js";
import { getLatestBrowserAccountSnapshot } from "./liveAccountOverride.js";
import { classifySession } from "../analytics/session.js";
import { getDailyTrend } from "./dailyTrendCache.js";
import { getDailyEma20Trend } from "./dailyEmaTrendCache.js";
import { getFixedTargetEdge } from "./fixedTargetEdgeCache.js";
import { getLatestOrderFlowSnapshot } from "./liveOrderFlowCache.js";
import { setLatestRegimeSnapshot } from "./regimeSnapshotCache.js";
import { getOpeningRangeStats } from "./openingRangeCache.js";
import { explainKillSwitch, explainRiskRejection, explainScore, explainTradeExit } from "../explain/engine.js";
import { executeIfApproved } from "../execution/engine.js";
import { evaluateExecutionOpportunity, pollRestingOpportunities } from "../execution/executionDecisionEngine.js";
import { getExecutionSettings, getSystemState, tripKillSwitch } from "../execution/mode.js";
import type { EmaTrend } from "../analytics/emaTrend.js";
import { getInstrument, type InstrumentSpec } from "../marketData/instruments.js";
import { getNewsRiskStatus } from "../news/risk.js";
import { classifyRegime } from "../regime/classifier.js";
import type { RegimeResult } from "../regime/classifier.js";
import { atr as computeAtr, type OhlcBar } from "../regime/indicators.js";
import {
  computeInitialStop,
  hasReachedTrailingStopActivation,
  RiskEngine,
  TRAILING_STOP_DISTANCE_TICKS,
  type RiskAssessment,
  type RiskLimitsConfig,
} from "../risk/index.js";
import { buildSetupFeatures, type SetupFeatures } from "../scoring/features.js";
import { evaluateSetup, type GatedScore } from "../scoring/gate.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import { ALL_STRATEGIES } from "../strategy/index.js";
import type { Signal } from "../strategy/types.js";
import { ACTIVE_INSTRUMENTS } from "../marketData/instruments.js";
import type { Account, Trade } from "@prisma/client";
import { decideOnBar } from "../replay/decisionCore.js";
import { LiveDecisionContext } from "../replay/liveDecisionContext.js";

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

// Scored on every signal alongside STRATEGY_VERSIONS (visible in the
// Recommendation Feed, directly comparable) but deliberately excluded from
// both consensus functions below, which only ever read from
// STRATEGY_VERSIONS -- shadow-only until the operator decides a version here
// is ready to actually vote. v5 (2026-07-21, see ruleScorerV5.ts) starts
// here; move a version to STRATEGY_VERSIONS instead once it's promoted.
// v6 (2026-08-02, see ruleScorerV6.ts) joins the same way -- order matters
// here: it must come after v5, since v6's ensemble needs v5's own result
// (see scoreAllVersions below and gate.ts's evaluateSetup 'v6' branch).
const SHADOW_ONLY_VERSIONS: StrategyVersion[] = ["v5", "v6"];

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

// Mutual-agreement consensus rule (2026-07-29, operator request): no single
// version should be able to drive a trade "on its own" -- v5 needs at least
// one of v1/v2/v3 to also confirm. Went through two shapes the same day
// before landing here: first "top 2 of 3 clear 75%, weakest just needs 56%"
// (no v5 involvement at all), then tightened to "all three of v1/v2/v3
// unanimously, AND v5 also clears 75%" -- confirmed live that stricter
// version was far too strict (individually each version only clears 75%+
// ~7-12% of the time; requiring all four simultaneously produced zero
// actionable recommendations and zero trades over several hours). Loosened
// back to: v5 must independently clear its own gate, AND at least ONE of
// v1/v2/v3 (not all three) must also clear the same bar -- v5 still can't
// act alone, but doesn't need a full v1/v2/v3 unanimous vote behind it
// either. v5 does not "vote" in the STRATEGY_VERSIONS sense (no
// representative-explanation slot, not part of the averaged probability
// below) -- it's a hard AND-gate alongside whichever single v1/v2/v3 version
// confirms.
//
// SUSPENDED, not deleted (2026-08-02, operator request): checked live
// against this deployment's actual scoring history before touching this --
// 0 of the last 124 fully-scored decision points passed this rule, 8 of
// those had v1 or v2 independently at 80%+ vetoed solely by v5 sitting in
// the 30-50% range. The honest fix is a real v6 scorer built the way v5
// itself was: mined from resolved trade outcomes, not hand-picked (see
// ruleScorerV5.ts and BUILD_HISTORY.md's v1.2 entry -- that took ~36k+
// resolved scores). This deployment currently has 1,684 total scores and
// ZERO resolved executed_win/executed_loss outcomes -- nowhere near enough
// to mine responsibly yet. Operator's explicit, informed call: trade
// strictness for trade volume now, evidence-free, as a stopgap, rather than
// stay at zero trades while outcome data accumulates. hasMutualAgreement/
// mutualAgreementSummary are left here, unused, specifically so reverting
// is a one-line swap back once a real v6 scorer -- or fresh evidence this
// rule should stay -- exists.
const MUTUAL_AGREEMENT_HIGH_THRESHOLD = 0.75;
const V5_EXECUTION_GATE_THRESHOLD = 0.75;

function hasMutualAgreement(probabilities: number[], v5Probability: number): boolean {
  return probabilities.some((p) => p >= MUTUAL_AGREEMENT_HIGH_THRESHOLD) && v5Probability >= V5_EXECUTION_GATE_THRESHOLD;
}

function mutualAgreementSummary(gatedByVersion: Map<StrategyVersion, GatedScore>, averageProbability: number): string {
  const agreeCount = STRATEGY_VERSIONS.filter((v) => gatedByVersion.get(v)!.probability >= MUTUAL_AGREEMENT_HIGH_THRESHOLD).length;
  const v5Probability = gatedByVersion.get("v5")!.probability;
  return `${agreeCount}/3 at ${Math.round(MUTUAL_AGREEMENT_HIGH_THRESHOLD * 100)}%+ (at least 1 needed), v5 gate needs ${Math.round(V5_EXECUTION_GATE_THRESHOLD * 100)}%+ (avg=${Math.round(averageProbability * 100)}%): ${STRATEGY_VERSIONS.map((v) => `${v}=${Math.round(gatedByVersion.get(v)!.probability * 100)}%`).join(", ")}, v5=${Math.round(v5Probability * 100)}%`;
}

// Any-single-version gate (2026-08-02, operator request): any ONE of
// v1/v2/v3/v5 independently clearing 65% is enough, including v5 acting
// entirely alone. Originally introduced scoped to trend_pullback_fib_buy
// only (that strategy's own narrow 15m rally/correction/fib pattern was
// already the primary filter, so this only needed one scorer not to
// actively disagree) -- widened the same day to every strategy and to
// determineContinuousScanConsensus, as the stopgap replacement for the
// mutual-agreement rule above.
//
// SUPERSEDED the same day, not deleted: once ruleScorerV6.ts existed (an
// ensemble of v1/v2/v3/v5 plus its own setup-rule bonus), the operator asked
// for v6 to anchor the gate the way v5 anchored the original mutual-
// agreement rule -- see hasV6MandatoryAgreement below, which calls
// hasAnySingleVersionAgreement as its "at least one other version" leg
// rather than duplicating it. Kept as a real, called function (not dead
// code) for exactly that reuse.
const LOOSE_GATE_THRESHOLD = 0.65;
const ALL_FOUR_VERSIONS: StrategyVersion[] = ["v1", "v2", "v3", "v5"];

function hasAnySingleVersionAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>): boolean {
  return ALL_FOUR_VERSIONS.some((v) => gatedByVersion.get(v)!.probability >= LOOSE_GATE_THRESHOLD);
}

// v6-mandatory gate (2026-08-02, operator request, same day as ruleScorerV6.ts
// itself): v6 must independently clear 65% AND at least one of v1/v2/v3/v5
// must also clear 65% -- v6 can no longer execute alone, and neither can any
// of v1/v2/v3/v5 without v6's agreement. Structurally the same shape as the
// original mutual-agreement rule (a mandatory anchor version + one
// independent confirmation), just with v6 -- built the same day, zero
// resolved live trades behind its own weight yet (see ruleScorerV6.ts's
// OWN_PATTERN_CONFIRMATION_BONUS_LOGIT comment) -- taking the anchor role v5
// held there. This is a materially different, NOT simply "the same gate with
// an extra check": v6's own probability is v1/v2/v3/v5 averaged by logit, so
// a single strong outlier (e.g. v1 at 90%, everything else weak) that would
// have passed the any-single-version gate above can now fail here if v6's
// blended read doesn't also clear 65%. Live with DRY_RUN_ORDERS=false at the
// time this was made the rule -- operator's explicit, informed call.
const V6_MANDATORY_THRESHOLD = 0.65;
const V6_MANDATORY_REPRESENTATIVE_ORDER: StrategyVersion[] = ["v6", "v3", "v2", "v1", "v5"];

function hasV6MandatoryAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>): boolean {
  const v6Probability = gatedByVersion.get("v6")!.probability;
  if (v6Probability < V6_MANDATORY_THRESHOLD) return false;
  return hasAnySingleVersionAgreement(gatedByVersion);
}

function v6MandatorySummary(gatedByVersion: Map<StrategyVersion, GatedScore>, averageProbability: number): string {
  const v6Probability = gatedByVersion.get("v6")!.probability;
  const agreeing = ALL_FOUR_VERSIONS.filter((v) => gatedByVersion.get(v)!.probability >= LOOSE_GATE_THRESHOLD);
  return (
    `v6-mandatory gate: v6 needs ${Math.round(V6_MANDATORY_THRESHOLD * 100)}%+ (v6=${Math.round(v6Probability * 100)}%), ` +
    `AND at least 1 of v1/v2/v3/v5 at ${Math.round(LOOSE_GATE_THRESHOLD * 100)}%+ ` +
    `(avg=${Math.round(averageProbability * 100)}%): ${ALL_FOUR_VERSIONS.map((v) => `${v}=${Math.round(gatedByVersion.get(v)!.probability * 100)}%`).join(", ")}` +
    (agreeing.length > 0 ? `, agreeing: ${agreeing.join(", ")}` : "")
  );
}

export function determineConsensus(gatedByVersion: Map<StrategyVersion, GatedScore>): ConsensusDecision {
  const probabilities = STRATEGY_VERSIONS.map((v) => gatedByVersion.get(v)!.probability);
  const averageProbability = probabilities.reduce((a, b) => a + b, 0) / probabilities.length;

  const taken = hasV6MandatoryAgreement(gatedByVersion);

  // Prefer a version that itself agrees ("taken") for the most meaningful
  // representative explanation, falling back to the order's first entry if
  // none of the candidates' own decision happens to read "taken" (possible
  // since a version's own gate decision can be blocked by its own additional
  // checks -- e.g. v3's directional-conviction margin -- even when its raw
  // probability contributed to agreement here). v6 leads the order now: it's
  // the mandatory anchor, and its own explanation already cites the other
  // four, making it the most representative single explanation of why this
  // trade actually happened.
  const takenVersions = V6_MANDATORY_REPRESENTATIVE_ORDER.filter((v) => gatedByVersion.get(v)!.decision === "taken");
  const representativeVersion = taken ? (V6_MANDATORY_REPRESENTATIVE_ORDER.find((v) => takenVersions.includes(v)) ?? V6_MANDATORY_REPRESENTATIVE_ORDER[0]!) : null;

  const summary = v6MandatorySummary(gatedByVersion, averageProbability);

  return { taken, representativeVersion, averageProbability, summary };
}

// Continuous-scan setups (see scanSymbolContinuously) have no detected chart
// pattern behind them -- unlike a real strategy signal, they're a bar-level
// directional read taken unconditionally on a timer. Shares the exact same
// rule as determineConsensus above (2026-07-14: unified across both signal
// types under mutual-agreement; 2026-08-02: both moved together first to the
// any-single-version gate, then to the v6-mandatory gate -- see those rules'
// comments).
export function determineContinuousScanConsensus(gatedByVersion: Map<StrategyVersion, GatedScore>): ConsensusDecision {
  return determineConsensus(gatedByVersion);
}

const logger = childLogger("engineLoop");

const MIN_BARS_FOR_REGIME = 120;

// scanSymbolContinuously is timer-driven (runs on a fixed interval, not off
// live ticks -- see its own header comment), so it re-reads "the last N
// bars" from the DB every tick regardless of whether new price data has
// actually arrived. Its only protection against re-scoring the same bar
// twice was lastContinuousScanBarTime (below) -- an in-memory map that
// resets to empty on every process restart. 2026-07-28 incident: the live
// price feed had been dead for ~17 hours (Chrome stuck on a non-trade page,
// see cdpClient.ts), but a routine backend restart (for an unrelated code
// change) reset that map, so the very next tick treated the same 17-hour-old
// bar as "new" again, re-ran consensus, and opened a real trade off a close
// price with zero live market data behind it. This is an absolute staleness
// check instead: reject outright whenever the newest bar itself is older
// than a live feed could ever legitimately produce, independent of whatever
// state the dedup map happens to be in.
const MAX_CONTINUOUS_SCAN_BAR_STALENESS_MS = 5 * 60_000;

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

    // Equity-curve history is tracked per real TopstepX account (2026-07-21
    // fix, scoped deliberately narrow) -- manageOpenTrades/trades/risk above
    // still use the single shared `account`, but the displayed equity curve
    // must not blend multiple real accounts an operator switches between in
    // the browser into one history. Falls back to the shared account
    // whenever there's no live browser snapshot yet (paper/analysis-only, or
    // before the watcher's first successful poll).
    const settings = getSettings();
    const mode = systemState.mode as TradingMode;
    let equityCurveAccount = account;
    if (settings.accountSource === AccountSource.BROWSER && mode === TradingMode.LIVE) {
      const snapshot = getLatestBrowserAccountSnapshot();
      if (snapshot?.brokerAccountId) {
        equityCurveAccount = await ensureAccountForBrokerId(snapshot.brokerAccountId, snapshot.accountName ?? snapshot.brokerAccountId);
      }
    }

    const now = Date.now();
    const lastAt = lastEquityPointAt.get(equityCurveAccount.id) ?? 0;
    if (now - lastAt >= EQUITY_POINT_MIN_INTERVAL_MS) {
      lastEquityPointAt.set(equityCurveAccount.id, now);
      await recordEquityPoint(
        equityCurveAccount.id,
        equity,
        new Decimal(equityCurveAccount.startingBalance.toString()),
        time,
        this.brokerKindForMode(mode)
      );
    }
    await this.emit({ type: "equity_update", accountId: equityCurveAccount.id, equity: equity.toString(), time: time.toISOString() });
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
  // the broker before acting:
  //   - confirmed flat (bracket did its job) -> just sync our record
  //   - confirmed still open, OR can't tell either way -> actively close it
  //     now (2026-07-19 operator report: a position that stayed open
  //     because isPositionFlat kept returning "can't tell" was exactly this
  //     gap -- "don't guess" is the right call for deciding *whether the
  //     broker's bracket already fired*, but the wrong call for deciding
  //     whether to act at all once our own stop/target has clearly been
  //     crossed; an unprotected position past its intended exit is worse
  //     than the small chance of a redundant close attempt). Tries the
  //     dedicated Close-Position button first, and falls back to flattening
  //     with an opposite-side order of the same quantity (reusing the same
  //     Buy/Sell click path already proven reliable for entries) if that
  //     doesn't work.
  private async manageLiveOpenTrade(account: Account, openTrade: Trade, symbol: string, barTime: Date, h: Decimal, l: Decimal): Promise<void> {
    const broker = this.brokerForTrade(openTrade);
    const brokerAccountId = (await broker.getAccounts())[0]!.accountId;
    const stopPrice = new Decimal(openTrade.stopPrice.toString());
    const takeProfitPrice = openTrade.takeProfitPrice ? new Decimal(openTrade.takeProfitPrice.toString()) : null;
    const entryPrice = new Decimal(openTrade.entryPrice.toString());
    const side = openTrade.side as "long" | "short";

    // v1.3: once price reaches halfway to the take-profit target, place a
    // real broker-side Trailing Stop order and stop relying on our own
    // internal stopPrice check below for this trade going forward -- see
    // risk/stops.ts's hasReachedTrailingStopActivation/activateTrailingStop.
    let trailingStopPlaced = openTrade.trailingStopPlaced;
    if (!trailingStopPlaced && takeProfitPrice !== null && hasReachedTrailingStopActivation(entryPrice, takeProfitPrice, side, h, l)) {
      trailingStopPlaced = await this.activateTrailingStop(openTrade, symbol);
    }

    // Automates the clear-pos skill: previously, isPositionFlat was only
    // ever checked *after* our own stored stop/target levels were crossed
    // below -- a phantom trade that was never really filled (the click
    // succeeded but the broker silently rejected the order -- see
    // execution/engine.ts's known fill-verification gap) or a position
    // closed out-of-band could otherwise sit "open" here indefinitely,
    // waiting for a price level that may never line up with real action.
    // Checking unconditionally, every tick, means it gets reconciled
    // automatically instead of requiring the operator to notice on the
    // dashboard and ask for it by hand.
    const isFlatNow = await broker.isPositionFlat?.(symbol);
    if (isFlatNow === true) {
      if (trailingStopPlaced) {
        // A real trailing-stop order was genuinely resting -- likely a real
        // fill. Its actual (server-side, trailed) trigger level isn't
        // visible to us, so this bar's adverse extreme is the best estimate.
        const exitPrice = side === "long" ? l : h;
        await this.closeTrade(account, { symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason: "stop", customTag: "estimated_from_trailing_stop" });
        logger.info({ symbol, tradeId: openTrade.id }, "live_trade_closed_via_trailing_stop");
      } else {
        // No real protective order was ever resting for this trade -- could
        // be a phantom that was never really filled, or a real position
        // closed out-of-band; no reliable exit economics exist for either
        // case (see reconcileBrokerFlatTrade).
        await this.reconcileBrokerFlatTrade(openTrade);
      }
      return;
    }

    // letItRide (Positions panel operator override, v1.3) cancels the
    // internal take-profit check -- from then on only a real fill (the
    // trailing stop, or a manual close) can end the trade.
    const hitTarget = !openTrade.letItRide && takeProfitPrice !== null && (side === "long" ? h.gte(takeProfitPrice) : l.lte(takeProfitPrice));
    // Once a real trailing-stop order is resting, IT -- not our stored
    // stopPrice -- is this trade's downside protection; a broker-driven fill
    // is caught by the isPositionFlat check above instead, since the real
    // trailing level (tracked server-side on TopstepX) can differ from
    // whatever stopPrice was computed at entry.
    const hitStop = !trailingStopPlaced && (side === "long" ? l.lte(stopPrice) : h.gte(stopPrice));

    if (!hitStop && !hitTarget) return;

    const exitReason: "stop" | "target" = hitStop ? "stop" : "target";
    const exitPrice = hitStop ? stopPrice : takeProfitPrice!;

    // Re-check right here (not just reuse isFlatNow from above) --
    // requestClosePosition's own DOM interaction takes real time below, and
    // TopstepX's bracket can fill for real in the window since isFlatNow was
    // last read.
    const isFlat = await broker.isPositionFlat?.(symbol);

    if (isFlat === true) {
      // Exit price is our own configured stop/target, not a confirmed fill
      // (this app has no way yet to read back TopstepX's actual fill price)
      // -- labeled as an estimate in the explanation, same as the manual
      // trade #122 reconciliation this replaces.
      await this.closeTrade(account, { symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: "estimated_from_bracket" });
      logger.info({ symbol, tradeId: openTrade.id, exitReason, exitPrice: exitPrice.toString() }, "live_trade_closed_synced_from_broker");
      return;
    }

    logger.error({ symbol, tradeId: openTrade.id, exitReason, isFlat }, "live_position_past_exit_forcing_close");

    let closeResult = await broker.requestClosePosition?.(symbol);
    let closeTag = "forced_after_bracket_failure";

    if (!closeResult || closeResult.status === "rejected") {
      // Re-check right here, not just once at the top -- requestClosePosition's
      // own DOM interaction takes real time, and TopstepX's bracket can fill
      // for real in that window. flattenPosition places a raw opposite-side
      // MARKET order with no awareness of whether anything is actually still
      // open: firing it against an already-flat position doesn't close
      // anything, it OPENS a new unwanted position (2026-07-19 incident: this
      // exact race left an untracked phantom long on the real account after
      // trade #156's short had already been closed by the broker's own
      // bracket -- see trade #157's reconciliation note).
      const stillOpen = await broker.isPositionFlat?.(symbol);
      if (stillOpen === true) {
        logger.info({ symbol, tradeId: openTrade.id }, "position_closed_itself_during_close_attempt_skipping_flatten");
        await this.closeTrade(account, { symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: "estimated_from_bracket" });
        return;
      }
      logger.warn({ symbol, tradeId: openTrade.id, error: closeResult?.error }, "close_position_failed_falling_back_to_flatten");
      closeResult = await broker.flattenPosition?.(symbol, openTrade.side as "long" | "short", openTrade.quantity);
      closeTag = "forced_close_via_opposite_order";
    }

    if (closeResult && closeResult.status !== "rejected") {
      await this.closeTrade(account, { symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: closeTag });
    } else {
      logger.error({ symbol, tradeId: openTrade.id, error: closeResult?.error }, "live_forced_close_failed");
    }
  }

  // v1.3: places the real broker-side Trailing Stop order that supersedes
  // this trade's internal stopPrice check (see manageLiveOpenTrade above and
  // risk/stops.ts's hasReachedTrailingStopActivation). Returns false (and
  // leaves trailingStopPlaced unset) on any failure -- the caller retries on
  // the next tick rather than silently leaving the trade unprotected.
  private async activateTrailingStop(openTrade: Trade, symbol: string): Promise<boolean> {
    const broker = this.brokerForTrade(openTrade);
    if (!broker.placeTrailingStop) {
      logger.warn({ symbol, tradeId: openTrade.id }, "trailing_stop_not_supported_by_broker");
      return false;
    }

    const result = await broker.placeTrailingStop(symbol, openTrade.side as "long" | "short", openTrade.quantity, TRAILING_STOP_DISTANCE_TICKS);
    if (result.status === "rejected") {
      logger.warn({ symbol, tradeId: openTrade.id, error: result.error }, "trailing_stop_activation_failed");
      return false;
    }

    await prisma.trade.update({ where: { id: openTrade.id }, data: { trailingStopPlaced: true } });
    await prisma.orderRecord.create({
      data: {
        tradeId: openTrade.id,
        brokerOrderId: result.brokerOrderId,
        accountId: openTrade.accountId,
        symbol,
        orderType: "trailing_stop",
        side: openTrade.side === "long" ? "sell" : "buy",
        quantity: openTrade.quantity,
        status: "pending",
      },
    });
    logger.info({ symbol, tradeId: openTrade.id, trailTicks: TRAILING_STOP_DISTANCE_TICKS }, "trailing_stop_activated");
    return true;
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

  // Automates the clear-pos skill for the one case closeTrade can't cover:
  // a trade with no real protective order ever resting (trailingStopPlaced
  // false), where the broker now reports flat but our own price levels
  // never crossed. Two indistinguishable real causes -- a phantom trade
  // that was never actually filled (see execution/engine.ts's known fill-
  // verification gap), or a real position closed entirely out-of-band (the
  // operator closing it directly, a lockout, anything broker-side) -- and
  // neither has a reliable exit price or pnl to report, so both are left
  // null rather than fabricated, exactly matching the clear-pos skill's own
  // manual convention.
  private async reconcileBrokerFlatTrade(trade: Trade): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: "closed",
        exitTime: new Date(),
        exitReason: "auto_reconciled",
        explanation:
          `${trade.explanation} [AUTO-RECONCILED ${today}: TopstepX confirmed no open position for this symbol, ` +
          `but this trade had no real protective order ever resting -- either a phantom trade that was never ` +
          `really filled, or a real position closed out-of-band. exit_price/pnl intentionally left null, since ` +
          `neither can be reliably determined for either case (see the clear-pos skill).]`,
      },
    });
    logger.warn({ symbol: trade.symbol, tradeId: trade.id }, "trade_auto_reconciled_broker_flat");
    await this.emit({ type: "trade_closed", tradeId: trade.id, symbol: trade.symbol, pnl: "0", explanation: "auto-reconciled: broker confirmed no open position" });
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
        : closed.customTag === "estimated_from_trailing_stop"
          ? " [exit price is an ESTIMATE (this bar's adverse extreme), not a confirmed fill -- the real broker-side Trailing Stop order (v1.3) closed this position server-side, and its actual trailing level isn't visible to this app]"
          : closed.customTag === "forced_after_bracket_failure"
            ? " [bracket failed to fire -- this app force-closed the position after price crossed the stop/target level]"
            : closed.customTag === "forced_close_via_opposite_order"
              ? " [bracket failed to fire and the Close-Position button didn't work either -- this app force-closed the position with an opposite-side order after price crossed the stop/target level]"
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
    const gatedByVersion = new Map<StrategyVersion, GatedScore>();
    for (const version of [...STRATEGY_VERSIONS, ...SHADOW_ONLY_VERSIONS]) {
      // v3 runs after v1/v2 (see STRATEGY_VERSIONS order) so it can
      // hard-override to "taken" when both already agreed (gate.ts's
      // v1v2Override). v6 (a complete, self-contained scorer as of
      // 2026-08-03 -- see ruleScorerV6.ts) only needs bars, not the other
      // four's results, but still runs last per SHADOW_ONLY_VERSIONS' order.
      let extra: Parameters<typeof evaluateSetup>[3];
      if (version === "v3") extra = { bars, v1Gated: gatedByVersion.get("v1"), v2Gated: gatedByVersion.get("v2"), signalKind };
      else if (version === "v6") extra = { bars };
      const gated = await evaluateSetup(features, version, barTime, extra);
      gatedByVersion.set(version, gated);
    }
    const scoreIdByVersion = await this.persistScores({
      gatedByVersion, features, symbol, side, strategyId, structureSwingPriceAtSignal,
      signalKind, breakoutLevelPrice, barTime, closePrice, atrValue, riskRewardRatio,
    });
    return { gatedByVersion, scoreIdByVersion };
  }

  // Extracted from scoreAllVersions above so the real-signal path
  // (evaluateNewSignals) can persist Score rows for a gatedByVersion map
  // that decideOnBar already produced, without asking evaluateSetup to run
  // a second time. scanSymbolContinuously still goes through
  // scoreAllVersions, which now just computes gatedByVersion and delegates
  // here -- same DB writes, same events, same order, nothing about its
  // behavior changes.
  private async persistScores(params: {
    gatedByVersion: Map<StrategyVersion, GatedScore>;
    features: SetupFeatures;
    symbol: string;
    side: "long" | "short";
    strategyId: string;
    structureSwingPriceAtSignal: Decimal | null;
    signalKind: "breakout" | "reversal" | undefined;
    breakoutLevelPrice: Decimal | null | undefined;
    barTime: Date;
    closePrice: Decimal;
    atrValue: Decimal;
    riskRewardRatio: number | null;
  }): Promise<Map<StrategyVersion, number>> {
    const { gatedByVersion, features, symbol, side, strategyId, structureSwingPriceAtSignal, signalKind, breakoutLevelPrice, barTime, closePrice, atrValue, riskRewardRatio } = params;
    const settings = getSettings();
    const scoreIdByVersion = new Map<StrategyVersion, number>();
    for (const [version, gated] of gatedByVersion) {
      const explanation = explainScore(symbol, side, gated, settings.minScoreThreshold);

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
    return scoreIdByVersion;
  }

  // Shared by scanSymbolContinuously and evaluateNewSignals -- previously
  // built inline inside attemptExecution, moved up to the callers since
  // attemptExecution no longer computes its own RiskAssessment (see below).
  private async loadRiskLimits(accountId: number): Promise<RiskLimitsConfig> {
    const riskLimitsRow = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId } });
    return {
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
  }

  // Shared consensus -> risk -> execution pipeline. Returns "consensus_not_reached"
  // or "risk_rejected" when the caller should keep trying other candidates for
  // the same bar; "kill_switch" or "executed" mean stop -- a kill switch trip
  // halts everything, and a risk-approved setup is the one and only position
  // this symbol gets this bar/tick regardless of whether the broker itself
  // filled it (assessment.approved already means it should have).
  //
  // `assessment` is now supplied by the caller instead of computed in here --
  // evaluateNewSignals gets it for free from decideOnBar (see
  // src/replay/decisionCore.ts), which runs the exact same
  // RiskEngine.assessNewTrade this function used to call itself.
  // scanSymbolContinuously computes its own (see its call site) since it
  // never goes through decideOnBar -- that path is intentionally untouched
  // by the replay-harness work (see .claude/rules/replay-harness.md's seam
  // map, which never mentions continuous scan). null means consensus wasn't
  // reached, so there was nothing to assess.
  private async attemptExecution(params: {
    consensus: ConsensusDecision;
    assessment: RiskAssessment | null;
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
    bars: OhlcBar[];
    barTime: Date;
    emaTrend: EmaTrend;
  }): Promise<{ outcome: "consensus_not_reached" | "risk_rejected" | "kill_switch" | "executed"; executed: boolean }> {
    const { consensus, assessment, gatedByVersion, scoreIdByVersion, account, mode, symbol, side, strategyId, structureSwingPrice, signalKind, breakoutLevelPrice, closePrice, atrValue, instrument, regime, bars, barTime, emaTrend } = params;

    if (!consensus.taken || !consensus.representativeVersion || !assessment) {
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
    const brokerKind = this.brokerKindForMode(mode);

    // Resting-limit-order path (Execution Decision Engine) instead of an
    // immediate market order -- gated on broker kind, not trading mode,
    // since brokerKindForMode only ever returns BROWSER_CONTROL when mode is
    // already LIVE (paper/analysis-only always resolve to SIMULATED above),
    // and SimulatedBroker doesn't implement isPositionFlat/cancelRestingOrder
    // that this path depends on (see executionDecisionEngine.ts's header).
    // Read fresh from the DB (not settings.executionDecisionEngineEnabled,
    // which is parsed from env once and cached for the process's lifetime)
    // so the dashboard toggle (see api/routes/system.ts) takes effect
    // immediately, same as the mode/kill-switch toggles.
    const executionDecisionEngineEnabled = (await getSystemState()).executionDecisionEngineEnabled;
    if (executionDecisionEngineEnabled && brokerKind === BrokerKind.BROWSER_CONTROL) {
      const edeResult = await evaluateExecutionOpportunity({
        symbol, side, strategyId, signalScore: decisionGated.probability,
        currentPrice: closePrice, atrValue, tickSize: instrument.tickSize,
        stopPrice: assessment.stopPrice!, takeProfitPrice: assessment.takeProfitPrice,
        quantity: assessment.quantity, bars, barTime, emaTrend,
        broker, brokerKind, accountId: account.id, brokerAccountId,
        regimeTrend: regime.trendLabel, regimeVol: regime.volLabel,
        explanation: decisionExplanation, scoreId: decisionScoreId,
      });
      await this.emit({ type: "execution", symbol, executed: edeResult.action === "filled", reason: edeResult.reason, tradeId: edeResult.tradeId });
      // waiting/already_resting/placed_resting_order/cancelled all mean "no
      // position opened (yet)" from this tick's point of view -- only a
      // confirmed fill is a real trade. kill_switch/risk_rejected/
      // consensus_not_reached are already handled above and don't reach
      // here, so "executed" is the only outcome bucket left that fits.
      return { outcome: "executed", executed: edeResult.action === "filled" };
    }

    // executeIfApproved only ever reads signal.symbol/side/strategyId --
    // structureSwingPrice on this object is unused there (it already fed the
    // stop-plan computation via RiskEngine.assessNewTrade, wherever the
    // caller ran it -- decideOnBar for the real-signal path, this function's
    // caller directly for continuous scan), so a placeholder satisfies the
    // Signal type without affecting anything.
    const signalForExecution: Signal = {
      strategyId, symbol, side,
      structureSwingPrice: structureSwingPrice ?? closePrice,
      reason: strategyId,
      signalKind,
      breakoutLevelPrice: breakoutLevelPrice ?? undefined,
    };
    const result = await executeIfApproved(
      broker, brokerKind, mode, account.id, brokerAccountId, signalForExecution, decisionGated, assessment,
      closePrice, regime.trendLabel, regime.volLabel, decisionExplanation, barTime, decisionScoreId
    );
    await this.emit({ type: "execution", symbol, executed: result.executed, reason: result.reason, tradeId: result.tradeId });
    return { outcome: "executed", executed: result.executed };
  }

  // decideOnBar (src/replay/decisionCore.ts) now owns everything from
  // "generate a signal" through "run RiskEngine.assessNewTrade" -- the exact
  // same code replay calls. This function's job has shrunk to: the
  // side-effects decideOnBar deliberately does NOT do (regime snapshot,
  // Score persistence, logging, kill-switch tripping, and actually placing
  // the order), applied to whatever decideOnBar decided.
  private async evaluateNewSignals(account: Account, mode: TradingMode, symbol: string, barTime: Date, closePrice: Decimal): Promise<void> {
    const bars: OhlcBar[] = await loadRecentBars(symbol, 300);
    if (bars.length < MIN_BARS_FOR_REGIME) return;

    const regime = classifyRegime(bars);
    setLatestRegimeSnapshot(symbol, {
      time: barTime, trendLabel: regime.trendLabel, volLabel: regime.volLabel,
      confidence: regime.confidence.toString(), features: JSON.parse(JSON.stringify(regime.features)),
    });
    await this.emit({ type: "regime", symbol, trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence });

    // Skip generating new entries into a symbol that already has an open position.
    const hasOpen = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" }, select: { id: true } });
    if (hasOpen) return; // excursion tracking for this open position already happened in manageOpenTrades

    // decideOnBar needs account state and risk limits resolved up front and
    // handed in synchronously (DecisionContext.accountState/riskLimits are
    // sync by design -- see replay/types.ts), unlike the old code which
    // fetched these inside attemptExecution, once per candidate strategy. No
    // trade closes mid-loop within a single bar's evaluation, so computing
    // this once per bar instead of once per candidate is a no-op change to
    // the result, not an approximation.
    const equity = await computeAccountEquity(account, new Map([[symbol, closePrice]]));
    const accountState = await computeAccountRiskState(account, equity);
    const riskLimits = await this.loadRiskLimits(account.id);
    const executionSettings = await getExecutionSettings();
    const dailyEma20Trend = await getDailyEma20Trend(symbol); // still needed below for attemptExecution's EDE call

    const ctx = new LiveDecisionContext({ accountId: account.id, accountState, riskLimits, executionSettings });
    const barDecisions = await decideOnBar({ ctx, symbol, barTime, closePrice });

    for (const decision of barDecisions) {
      if (!decision.signal) continue; // "no strategy fired" sentinel -- nothing to persist or execute

      const scoreIdByVersion = await this.persistScores({
        gatedByVersion: decision.gatedByVersion, features: decision.features!, symbol,
        side: decision.signal.side, strategyId: decision.signal.strategyId,
        structureSwingPriceAtSignal: decision.signal.structureSwingPrice,
        signalKind: decision.signal.signalKind, breakoutLevelPrice: decision.signal.breakoutLevelPrice,
        barTime, closePrice, atrValue: decision.atrValue!, riskRewardRatio: decision.riskRewardRatio,
      });

      // Both paper and live require the majority-vote consensus decideOnBar
      // already computed (a deliberate change: 2026-07-14 introduced
      // cross-version agreement at all, 2026-07-16 replaced an average-based
      // rule with this one so a single strongly-disagreeing version can't
      // veto two others' agreement).
      const result = await this.attemptExecution({
        consensus: decision.consensus, assessment: decision.plan,
        gatedByVersion: decision.gatedByVersion, scoreIdByVersion, account, mode, symbol,
        side: decision.signal.side, strategyId: decision.signal.strategyId,
        structureSwingPrice: decision.signal.structureSwingPrice, signalKind: decision.signal.signalKind,
        breakoutLevelPrice: decision.signal.breakoutLevelPrice,
        closePrice, atrValue: decision.atrValue!, instrument: getInstrument(symbol), regime, bars, barTime,
        emaTrend: dailyEma20Trend,
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

    // Poll any already-resting EDE opportunity for this symbol (both sides)
    // on every tick -- deliberately BEFORE the bar-dedup/consensus checks
    // below, since a fill-check gated behind a fresh signal reaching
    // consensus again silently stops running the moment that signal lapses
    // (see execution/executionDecisionEngine.ts's header comment on the
    // 2026-07-20 incident this fixes). Wrapped in try/catch so a broker
    // hiccup here (e.g. live broker momentarily disconnected) can't block
    // this tick's regular scoring/analysis below.
    const brokerKindForPoll = this.brokerKindForMode(mode);
    if (brokerKindForPoll === BrokerKind.BROWSER_CONTROL) {
      try {
        const systemState = await getSystemState();
        if (systemState.executionDecisionEngineEnabled) {
          const broker = this.brokerForMode(mode);
          const pollResults = await pollRestingOpportunities({ symbol, broker, brokerKind: brokerKindForPoll, barTime });
          for (const pollResult of pollResults) {
            await this.emit({ type: "execution", symbol, executed: pollResult.action === "filled", reason: pollResult.reason, tradeId: pollResult.tradeId });
          }
        }
      } catch (err) {
        logger.warn({ symbol, err: String(err) }, "execution_decision_engine_poll_failed");
      }
    }

    // None of these four depend on each other's result -- they were
    // previously awaited one at a time, paying for each one's DB round-trip
    // (or, on a cache miss, a genuinely expensive aggregate query) serially.
    const [bars, newsStatus, openingRangeStats, dailyTrend, dailyEma20Trend] = await Promise.all([
      loadRecentBars(symbol, 300),
      getNewsRiskStatus(barTime),
      getOpeningRangeStats(symbol),
      getDailyTrend(symbol),
      getDailyEma20Trend(symbol),
    ]);
    if (bars.length < MIN_BARS_FOR_REGIME) return;

    const lastBar = bars[bars.length - 1]!;
    const lastBarTimeMs = lastBar.time.getTime();

    const staleForMs = barTime.getTime() - lastBarTimeMs;
    if (staleForMs > MAX_CONTINUOUS_SCAN_BAR_STALENESS_MS) {
      logger.warn({ symbol, lastBarTime: lastBar.time.toISOString(), staleForMs }, "continuous_scan_skipped_stale_data");
      return;
    }

    if (lastContinuousScanBarTime.get(symbol) === lastBarTimeMs) return; // nothing new since the last tick -- skip the recompute and the duplicate write
    lastContinuousScanBarTime.set(symbol, lastBarTimeMs);

    const closePrice = new Decimal(lastBar.close);

    const regime = classifyRegime(bars);
    const session = classifySession(barTime);
    const instrument = getInstrument(symbol);
    const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
    if (atrSeries.length === 0) return;
    const atrValue = new Decimal(atrSeries[atrSeries.length - 1]!);
    const executionSettings = await getExecutionSettings();

    // Long and short are independent hypothetical reads over the same bars
    // -- scored concurrently (each writes its own Score rows, one per
    // version, distinct strategyId per side, so there's no shared mutable
    // state or write conflict between them). Execution is deliberately NOT
    // part of this Promise.all -- see below.
    const sideResults = await Promise.all(
      (["long", "short"] as const).map(async (side) => {
        const openingRangeBreakoutProbability = side === "long" ? openingRangeStats.probHighBroken : openingRangeStats.probLowBroken;
        const longTargetEdge = side === "long" ? await getFixedTargetEdge(symbol, session, "long", barTime) : null;

        const hypotheticalStopPlan = computeInitialStop(closePrice, side, atrValue, null, { tickSize: instrument.tickSize, takeProfitRMultiple: executionSettings.takeProfitRMultiple });
        const riskRewardRatio = hypotheticalStopPlan.stopDistancePoints.gt(0)
          ? hypotheticalStopPlan.takeProfitPrice.minus(closePrice).abs().dividedBy(hypotheticalStopPlan.stopDistancePoints).toNumber()
          : null;

        const features = buildSetupFeatures(
          bars, symbol, side, regime, barTime, newsStatus.inRiskWindow, newsStatus.minutesToEvent,
          null, openingRangeBreakoutProbability, openingRangeStats.sessionsAnalyzed,
          dailyTrend.trendLabel, dailyTrend.confidence,
          longTargetEdge?.winRate ?? null, longTargetEdge?.sampleSize ?? 0,
          riskRewardRatio, getLatestOrderFlowSnapshot(symbol), dailyEma20Trend
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

      // attemptExecution no longer computes its own RiskAssessment (the
      // real-signal path gets one for free from decideOnBar) -- this path
      // doesn't go through decideOnBar, so it still builds one itself,
      // exactly like attemptExecution used to inline, gated the same way:
      // only when consensus was actually reached.
      let assessment: RiskAssessment | null = null;
      if (consensus.taken) {
        const equity = await computeAccountEquity(account, new Map([[symbol, closePrice]]));
        const accountState = await computeAccountRiskState(account, equity);
        const limits = await this.loadRiskLimits(account.id);
        assessment = this.riskEngine.assessNewTrade({
          side, entryPrice: closePrice, atrValue,
          structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
          accountState, limits,
          pointValue: instrument.pointValue, tickSize: instrument.tickSize, newsStatus, bars,
          averageProbability: consensus.averageProbability,
          takeProfitRMultiple: executionSettings.takeProfitRMultiple,
          confidenceTiers: executionSettings.confidenceTiers,
        });
      }

      const result = await this.attemptExecution({
        consensus, assessment, gatedByVersion, scoreIdByVersion, account, mode, symbol, side, strategyId,
        structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
        closePrice, atrValue, instrument, regime, bars, barTime, emaTrend: dailyEma20Trend,
      });
      if (result.outcome === "kill_switch") return;
    }
  }
}
