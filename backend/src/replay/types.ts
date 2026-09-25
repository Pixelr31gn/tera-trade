/**
 * Replay harness — shared types.
 *
 * The whole design rests on one rule: the live engine and the harness call
 * the SAME decision code (decisionCore.ts). Everything that differs between
 * them — where bars come from, what "historical win rate" means, whether an
 * order really goes to a broker — is hidden behind the interfaces below.
 *
 * If you ever find yourself writing an `if (isReplay)` inside scoring, risk,
 * or strategy code, stop: that branch is exactly how a harness starts lying
 * to you.
 */
import type { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import type { RegimeResult } from "../regime/classifier.js";
import type { NewsRiskStatus } from "../news/risk.js";
import type { OpeningRangeStats } from "../analytics/openingRange.js";
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";
import type { EmaTrend } from "../analytics/emaTrend.js";
import type { AccountRiskState, RiskAssessment, RiskLimitsConfig } from "../risk/index.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import type { GatedScore } from "../scoring/gate.js";
import type { SetupFeatures } from "../scoring/features.js";
import type { determineConsensus } from "../engine/loop.js";
import type { BanditSelectionResult } from "../scoring/consensusBandit.js";
import type { SessionPerformanceSelection } from "../scoring/sessionPerformance.js";
import type { DealerLevelResult } from "../marketData/dealerGex.js";
import type { DailyPlanZone } from "../risk/engine.js";

/** `ConsensusDecision` itself isn't exported by loop.ts — pull its shape off the exported function rather than redeclaring it, so a field rename there breaks the build here instead of silently drifting. */
type ConsensusDecision = ReturnType<typeof determineConsensus>;

/** Operator-adjustable, shared across every strategy/version -- see execution/mode.ts's setTakeProfitRMultiple/setConfidenceTiers and DecisionContext.executionSettings below. */
export interface ExecutionSettings {
  takeProfitRMultiple: Decimal;
  confidenceTiers: [minAverageProbability: number, quantity: number][];
}

/**
 * Every piece of context the decision pipeline needs that does NOT come from
 * the bar window itself.
 *
 * In live, these are the existing caches (dailyTrendCache, openingRangeCache,
 * fixedTargetEdgeCache, liveOrderFlowCache, news/risk). In replay they are
 * recomputed as-of `at`, from data whose timestamp is strictly < `at`.
 *
 * NOTE the `at: Date` on every method. That parameter is the entire point of
 * this interface. The live implementations currently key off Date.now()
 * internally; the live adapter just ignores `at` and keeps its TTL cache.
 */
export interface DecisionContext {
  /** Ascending OHLC history ending at the just-closed bar. Live: loadRecentBars(symbol, 300). */
  recentBars(symbol: string, count: number, at: Date): Promise<OhlcBar[]>;

  /** Daily-timeframe regime. Live: getDailyTrend(symbol). */
  dailyTrend(symbol: string, at: Date): Promise<RegimeResult>;

  /** Daily EMA20 trend. Live: getDailyEma20Trend(symbol). */
  dailyEmaTrend(symbol: string, at: Date): Promise<EmaTrend>;

  /** Live: getNewsRiskStatus(barTime) — already time-parameterized, easiest port. */
  newsRisk(at: Date): Promise<NewsRiskStatus>;

  /** Live: getOpeningRangeStats(symbol). MUST exclude sessions >= `at` in replay. */
  openingRange(symbol: string, at: Date): Promise<OpeningRangeStats>;

  /**
   * Live: getFixedTargetEdge(symbol, session, side).
   * LOOK-AHEAD LANDMINE — the live query is unbounded in time. See PITFALLS.
   */
  fixedTargetEdge(
    symbol: string,
    session: string,
    side: "long" | "short",
    at: Date,
  ): Promise<{ winRate: number | null; sampleSize: number } | null>;

  /**
   * Live: getLatestOrderFlowSnapshot(symbol).
   * Returns null in replay, always — CDP order flow cannot be backfilled.
   * Track how often this is null; it is the main reason replay != live.
   */
  orderFlow(symbol: string, at: Date): OrderFlowSnapshot | null;

  /**
   * Live: computeAccountRiskState(...) off the Account/Trade tables.
   * In replay the harness owns a synthetic account and answers from it.
   */
  accountState(at: Date): AccountRiskState;

  riskLimits(): RiskLimitsConfig;

  /**
   * Operator-adjustable execution settings (SystemState -- see
   * execution/mode.ts's setTakeProfitRMultiple/setConfidenceTiers), shared
   * across every strategy and scoring version. Sync by design, same reason
   * as accountState/riskLimits above (see LiveDecisionContext's header
   * comment) -- resolved once per bar by the caller, not fetched here.
   */
  executionSettings(): ExecutionSettings;

  /** Open position for this symbol, if any. Live: prisma.trade.findFirst({status:"open"}). */
  hasOpenPosition(symbol: string, at: Date): Promise<boolean>;

  /**
   * Is `symbol`'s correlated partner (ES<->NQ, see
   * marketData/instruments.ts's getConflictingPartnerSymbol) currently
   * holding an open position on the OPPOSITE side of `side`? (2026-09-01,
   * operator request: "ES and NQ should never enter into conflicting
   * trades" -- see risk/engine.ts's hasConflictingCrossSymbolPosition param
   * for where this actually blocks a trade.) Live:
   * engine/crossSymbolConflictCheck.ts's hasConflictingCrossSymbolPosition.
   * Replay: the harness's own in-memory openPositions map.
   */
  hasConflictingPosition(symbol: string, side: "long" | "short", at: Date): Promise<boolean>;

  /**
   * Contextual UCB1 bandit selection for the v1/v2/v3/v6/v7 leg of
   * determineConsensus (scoring/consensusBandit.ts) -- `bucket` is
   * analytics/contextBucket.ts's computeContextBucket(session, trendLabel,
   * volLabel) for the bar being decided. Live: engine/consensusBanditCache.ts's
   * getBanditVersionSelection (TTL-cached). Replay: computeBanditSelection
   * called directly every time -- see replayDecisionContext.ts for why a
   * wall-clock cache would be wrong here (same reasoning as fixedTargetEdge).
   */
  banditVersionSelection(bucket: string, at: Date): Promise<BanditSelectionResult>;

  /**
   * Rolling session-performance selection for the "session-best-version"
   * consensus gate (2026-08-10, operator request): ranks
   * scoring/sessionPerformance.ts's SESSION_PERFORMANCE_ARMS (the same
   * v1/v2/v3/v6/v7 pool the bandit above uses) by realized win rate within
   * the CURRENT trading session only (analytics/session.ts's
   * getSessionStart) -- no context bucketing, no exploration bonus, just
   * whichever version is winning right now. SUPERSEDES the bandit leg above
   * as of this change (banditVersionSelection is kept, unused, for a
   * one-line revert -- see engine/loop.ts's hasSessionBestVersionAgreement
   * comment). Live: engine/sessionPerformanceCache.ts (TTL-cached, short
   * TTL -- see its own header comment for why). Replay:
   * computeSessionPerformanceSelection called directly every time, same
   * look-ahead-safety reasoning as banditVersionSelection above.
   */
  sessionPerformanceSelection(at: Date): Promise<SessionPerformanceSelection>;

  /**
   * Dealer gamma exposure (GEX) levels for the current trading session
   * (analytics/dealerGex.ts's pure math, marketData/dealerGex.ts's CBOE
   * fetch/persist, engine/dealerGexCache.ts's session-scoped cache) -- feeds
   * risk/engine.ts's new dealer-level proximity gate (2026-08-11, operator
   * request). `recentBars` is passed through so the S/R-pivot confirmation
   * cross-check can reuse the bar window decideOnBar already loaded rather
   * than fetching its own. Null when unavailable -- CBOE fetch failed, this
   * session's levels haven't been computed yet, or (ALWAYS true in replay)
   * CBOE's historical options chain cannot be backfilled, same fidelity
   * limit as orderFlow above. decideOnBar records a null result via
   * degraded[] (same convention as orderFlow) -- the gate itself fails open
   * on null rather than inventing a rejection, so this never silently
   * changes what a historical replay would have done; it just means the
   * gate's restrictive effect is 100% un-replayable going forward, exactly
   * like order flow already is. Live: engine/dealerGexCache.ts. Replay:
   * always returns null directly, no DB/cache involved.
   */
  dealerLevels(symbol: string, recentBars: OhlcBar[], at: Date): Promise<DealerLevelResult | null>;

  /**
   * This session's key price zones for this symbol, set by the AI
   * assistant's daily-plan tool -- manually or via its own scheduler,
   * assistant/dailyPlanScheduler.ts (2026-08-29, see risk/engine.ts's
   * DailyPlanZone/classifyDailyPlanZone). Live: engine/dailyPlanZoneCache.ts,
   * TTL-cached and scoped to `at`'s session (analytics/session.ts's
   * getSessionStart). Replay: ALWAYS returns [] (empty), unconditionally --
   * and deliberately does NOT report this via
   * contextDegradations() the way orderFlow/dealerLevels do. Those two are
   * real data live actually has that replay genuinely can't reconstruct (a
   * fidelity GAP). This is different: an LLM-authored "today's plan" has no
   * meaning for a historical replay date at all -- there is no true value
   * replay is failing to recover, so reporting it as degraded would suggest
   * a gap that isn't really there. Real, worth knowing anyway: if you
   * replay a window covering the actual present while the assistant
   * currently has zones set, live's gate would restrict trades that replay
   * won't -- a genuine live/replay divergence, just not the "missing
   * historical data" kind the rest of this file tracks.
   */
  dailyPlanZones(symbol: string, at: Date): Promise<DailyPlanZone[]>;

  /**
   * This session's assistant-estimated take-profit CEILING for `symbol`, in
   * points -- DAILY_PLAN_TAKE_PROFIT_FRACTION of its likely-move read (see
   * engine/dailyPlanTakeProfitCache.ts's getAssistantTakeProfitCapPoints), or
   * null when nothing has been set this session.
   *
   * 2026-09-25, operator report: targets were "still exceeding the tp point
   * cap." They were -- the cap only ever reached risk/engine.ts through the
   * continuous-scan call site. Real strategy signals come through decideOnBar,
   * which passed the STATIC HARD_TAKE_PROFIT_DOLLARS constant and no cap at
   * all, so every one of them was sized by the generic R-multiple path with no
   * ceiling: live trade 121 got a 481.50pt target (3 x a 160.50pt stop) against
   * a session cap of 73.33.
   *
   * Injected rather than read directly, same as dailyPlanZones above, because
   * risk/ and the decision core stay DB-free and because the `at` bound is
   * what keeps replay honest. Live: TTL-cached per session. Replay: ALWAYS
   * null, same reasoning as dailyPlanZones -- an assistant's read of "today's
   * realistic range" has no meaning for a historical bar, so replay simply
   * has no ceiling rather than a fabricated one.
   */
  assistantTakeProfitCapPoints(symbol: string, at: Date): Promise<Decimal | null>;

  /**
   * strategyIds currently taken out of live signal generation (see prisma's
   * DisabledStrategy model, engine/strategyEnablementCache.ts,
   * assistant/tools.ts's disable_strategy/enable_strategy tools) --
   * 2026-08-30, operator request, in response to a live strategy-performance
   * breakdown showing one strategy lagging heavily in a specific regime.
   * Live: TTL-cached. Replay: ALWAYS returns an empty set -- same reasoning
   * as dailyPlanZones above (a live operator/assistant toggle has no
   * meaning for a historical replay date, so this is never "degraded,"
   * just genuinely inapplicable).
   */
  disabledStrategyIds(): Promise<Set<string>>;

  /**
   * Symbols currently taken out of live signal generation entirely (see
   * prisma's DisabledSymbol model, engine/symbolEnablementCache.ts) --
   * 2026-09-03, operator request: "add a toggle so i can turn off which
   * markets are executable." Coarser than disabledStrategyIds above -- this
   * stops every strategy/path for the symbol, not just one. Live: TTL-cached.
   * Replay: ALWAYS returns an empty set, same reasoning as
   * disabledStrategyIds (a live operator toggle has no meaning for a
   * historical replay date).
   */
  disabledSymbols(): Promise<Set<string>>;

  /**
   * (strategyId, symbol) pairs currently taken out of live signal generation for THAT symbol only
   * (see prisma's DisabledStrategySymbol model, engine/strategySymbolEnablementCache.ts's
   * strategySymbolKey for the composite-key encoding) -- 2026-09-04, operator request, in direct
   * response to a per-symbol performance breakdown showing a strategy strong on one instrument and
   * losing on others: "only trade the winning signals." Finer than disabledStrategyIds above, not
   * a replacement for it -- a strategyId can be blocked by either gate independently. Live:
   * TTL-cached. Replay: ALWAYS returns an empty set, same reasoning as disabledStrategyIds/
   * disabledSymbols (a live operator toggle has no meaning for a historical replay date).
   */
  disabledStrategySymbolPairs(): Promise<Set<string>>;

  /**
   * Fields degraded on the CONTEXT side since the last call — decideOnBar
   * merges this into its own degraded[] list right after fetching
   * newsRisk/openingRange/dailyTrend/dailyEmaTrend. Live has nothing to
   * report here (a real-time DB query against actually-happening data has no
   * "did we get enough historical rows" question the way replay's as-of
   * queries do) and always returns []. Only ReplayDecisionContext ever
   * reports — e.g. when prisma.dailyBar or prisma.newsEvent has no coverage
   * for the window being replayed.
   */
  contextDegradations(): string[];
}

/** What the decision core produces for a single bar. Pure data — no side effects. */
export interface BarDecision {
  symbol: string;
  barTime: Date;
  /** null when no strategy fired at all on this bar. */
  signal: {
    strategyId: string;
    side: "long" | "short";
    signalKind: "breakout" | "reversal";
    structureSwingPrice: Decimal | null;
    breakoutLevelPrice: Decimal | null;
    /**
     * Carried through from Signal.explicitStopPrice/explicitTakeProfitPrice
     * (strategy/types.ts) so a second live venue (see the Tradesea
     * integration, engine/loop.ts's evaluateNewSignals) can re-run
     * RiskEngine.assessNewTrade with its own account state but the EXACT
     * same inputs the primary venue's plan used -- added 2026-08-27, additive
     * only, no existing consumer's behavior changes.
     */
    explicitStopPrice: Decimal | null;
    explicitTakeProfitPrice: Decimal | null;
  } | null;
  /** The full feature vector scored for this signal — null when signal is null. Live persists this verbatim onto the Score row (see loop.ts's persistScores); kept here rather than dropped so live doesn't need to rebuild it. */
  features: SetupFeatures | null;
  /** null when signal is null. */
  atrValue: Decimal | null;
  riskRewardRatio: number | null;
  /** Every version's score, always — including shadow-only versions. */
  gatedByVersion: Map<StrategyVersion, GatedScore>;
  consensus: ConsensusDecision;
  /**
   * RiskEngine.assessNewTrade's actual output, reused verbatim (not
   * hand-copied into a lookalike shape) so a field added there — or renamed,
   * the way ConsensusDecision's were — breaks the build here instead of
   * silently drifting. Populated only when consensus was reached.
   * `entryPrice` is the one thing decideOnBar adds beyond RiskAssessment
   * itself, since RiskEngine.assessNewTrade takes it as an input rather than
   * returning it -- as of 2026-08-09 it's analytics/smartEntry.ts's picked
   * price, not necessarily the raw signal/bar-close price (see
   * smartEntryBasis/smartEntryReason for which and why).
   */
  plan: (RiskAssessment & { entryPrice: Decimal; smartEntryBasis: "poc" | "vwap" | "signal_price"; smartEntryReason: string }) | null;
  /** Which context fields were unavailable — the replay-vs-live fidelity record. */
  degraded: string[];
}

export interface ReplayConfig {
  symbols: string[];
  from: Date;
  to: Date;
  startingEquity: number;
  /** Bars to warm up before the first decision is allowed. Must be >= MIN_BARS_FOR_REGIME. */
  warmupBars: number;
  /**
   * Dollars per contract, one side (harness.ts's realizedPnl charges it
   * twice per round-turn trade). NOT sourced from evidence -- this codebase
   * has no commission constant anywhere to inherit from, and Topstep's/your
   * data-feed broker's actual rate isn't something to guess at (see
   * CLAUDE.md: "'Cleaner' is not evidence" applies to numbers too). Defaults
   * to 0, which UNDERSTATES real P&L -- supply your real per-side commission
   * before trusting any replay result, per replay-harness.md's "costs are
   * not optional."
   */
  commissionPerContractPerSide?: number;
  /** Overrides applied to core/config.ts settings for this run — the sweep knob. */
  settingsOverride?: Record<string, unknown>;
}

export interface ReplayTrade {
  symbol: string;
  strategyId: string;
  side: "long" | "short";
  representativeVersion: StrategyVersion | null;
  entryTime: Date;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  quantity: number;
  exitTime: Date | null;
  exitPrice: number | null;
  exitReason: "stop" | "target" | "trail" | "eod" | "unresolved";
  rMultiple: number;
  pnl: number;
  degraded: string[];
}

export interface ReplayResult {
  config: ReplayConfig;
  trades: ReplayTrade[];
  /** One row per scored setup, taken or skipped — the calibration dataset. */
  decisions: BarDecision[];
  equityCurve: Array<{ time: Date; equity: number }>;
  metrics: Record<string, number>;
  /** Fraction of decisions that ran without full context. Report this always. */
  degradationRate: number;
  /**
   * First bar at which any symbol's RiskEngine.assessNewTrade tripped the
   * kill switch, if any -- null if it never tripped. Once set, runReplay
   * stops evaluating NEW entries for the rest of the run (all symbols,
   * account-wide), matching live's getSystemState().killSwitch gate in
   * onNewBar; existing open positions still get resolved against later bars,
   * same as live's manageOpenTrades keeps running regardless of the switch.
   * Report this always -- a run that hit this isn't a clean read of the
   * parameters being swept.
   */
  killSwitchTrippedAt: Date | null;
}
