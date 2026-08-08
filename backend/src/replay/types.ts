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
   * returning it.
   */
  plan: (RiskAssessment & { entryPrice: Decimal }) | null;
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
