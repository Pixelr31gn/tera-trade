/**
 * DecisionContext backed by historical data, recomputed as-of a specific
 * bar time instead of live's "now." This is the half of the harness that
 * makes replay numbers trustworthy or not — every method here is a place a
 * look-ahead bug can hide. See .claude/rules/replay-harness.md before
 * changing anything below.
 *
 * Owns the "synthetic account" runReplay's DecisionContext comment refers
 * to: equity, drawdown, and trade-count bookkeeping live entirely in this
 * class rather than in runReplay's own locals, so RiskEngine.assessNewTrade
 * sees the same circuit-breaker shape it would live (risk/circuitBreakers.ts).
 * runReplay drives this bookkeeping by calling advanceTo/recordTradeOpened/
 * recordTradeClosed/markOpen/markClosed at the same points it already
 * mutates its own equity curve and open-position map — see harness.ts.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { classifyRegime, type RegimeResult } from "../regime/classifier.js";
import { classifyEmaTrend, type EmaTrend } from "../analytics/emaTrend.js";
import { computeOpeningRangeStats, type OpeningRangeStats } from "../analytics/openingRange.js";
import { getNewsRiskStatus, type NewsRiskStatus } from "../news/risk.js";
import { getConflictingPartnerSymbol, getInstrument } from "../marketData/instruments.js";
import { computeFixedTargetEdge } from "../engine/fixedTargetEdgeCache.js";
import { computeBanditSelection, CONSENSUS_BANDIT_ARMS, type BanditSelectionResult } from "../scoring/consensusBandit.js";
import { computeSessionPerformanceSelection, SESSION_PERFORMANCE_ARMS, type SessionPerformanceSelection } from "../scoring/sessionPerformance.js";
import type { DealerLevelResult } from "../marketData/dealerGex.js";
import type { OhlcBar } from "../regime/indicators.js";
import { getSessionStart, type TradingSession } from "../analytics/session.js";
import { DEFAULT_CONFIDENCE_TIERS } from "../risk/sizing.js";
import type { AccountRiskState, DailyPlanZone, RiskLimitsConfig } from "../risk/index.js";
import type { DecisionContext, ExecutionSettings } from "./types.js";

// Mirrors risk/engine.ts's real hardcoded-turned-operator-adjustable default
// (SystemState.takeProfitRMultiple) -- replay's own default when a run
// doesn't explicitly override it via the constructor, so an un-configured
// replay matches live's own default behavior rather than silently reverting
// to stops.ts's generic 3.0 pure-function fallback.
const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = { takeProfitRMultiple: new Decimal("2.0"), confidenceTiers: DEFAULT_CONFIDENCE_TIERS };

// Mirrors engine/dailyTrendCache.ts's LOOKBACK_DAYS. Kept separate (not
// imported) because that constant is private to a module built around a
// wall-clock TTL cache this class deliberately does not use — see
// computeFixedTargetEdge's export comment for why sharing the live cache
// itself, not just its constant, would be the actual bug to avoid.
const DAILY_TREND_LOOKBACK_DAYS = 200;
const DAILY_EMA_LOOKBACK_DAYS = 90;
const DAILY_EMA_PERIOD = 20;

// Filters an already-fetched daily-bar array down to [at - lookbackDays, at) --
// same bound loadDailyBarsAsOf's DB query used to apply, just against an
// in-memory array instead of a fresh query. DailyBar rows are historical and
// don't change mid-run, so fetching a symbol's full set once and filtering
// it per call is behaviorally identical to re-querying every time, but
// without paying a DB round trip on every single bar decision -- confirmed
// live (2026-08-02) that the per-bar re-query was the dominant cost in a
// 20-day/2-symbol run (~7,600 bar-decisions x 2 daily-bar queries each,
// ~30+ minutes over Docker's WSL2-networked Postgres on this machine) with
// this same replay producing a result in seconds once cached.
function filterDailyBarsAsOf(bars: OhlcBar[], at: Date, lookbackDays: number): OhlcBar[] {
  const since = at.getTime() - lookbackDays * 86_400_000;
  return bars.filter((b) => b.time.getTime() >= since && b.time.getTime() < at.getTime());
}

interface OpenPositionMarker {
  side: "long" | "short";
  entryPrice: Decimal;
  quantity: number;
  pointValue: Decimal;
}

/** The sweep knobs for scripts/replayBanditEval.ts -- overrides scoring/consensusBandit.ts's own defaults. `forceColdStart` runs the A/B baseline leg (today's plain hasV1V2V3MajorityAgreement rule, exercised via hasBanditSelectedVersionAgreement's own coldStart fallback) without needing a second set of DB queries. */
export interface BanditConfigOverride {
  explorationConstant?: number;
  minBucketSamples?: number;
  minPerArmSamples?: number;
  forceColdStart?: boolean;
}

/** Same sweep-knob shape as BanditConfigOverride above, for the session-performance gate that superseded the bandit leg (scoring/sessionPerformance.ts). */
export interface SessionPerformanceConfigOverride {
  minSamplesPerVersion?: number;
  forceColdStart?: boolean;
}

export class ReplayDecisionContext implements DecisionContext {
  private openPositions = new Map<string, OpenPositionMarker>();
  /** Latest known close per symbol, for mark-to-market -- updated every bar regardless of whether that symbol has a position open. */
  private lastPrice = new Map<string, Decimal>();
  private equity: Decimal;
  private peakEquity: Decimal;
  private dailyStartingEquity: Decimal;
  private currentDayKey: string | null = null;
  private consecutiveLosses = 0;
  private tradesToday = 0;

  constructor(
    private barsBySymbol: Map<string, OhlcBar[]>,
    startingEquity: number,
    private limits: RiskLimitsConfig,
    /** Optional -- the sweep knob for testing a different reward:risk/confidence-tier configuration against historical data. Defaults to live's own current defaults, not stops.ts's generic fallback (see DEFAULT_EXECUTION_SETTINGS above). */
    private settings: ExecutionSettings = DEFAULT_EXECUTION_SETTINGS,
    /** Optional -- scripts/replayBanditEval.ts's A/B sweep knob for the consensus bandit's own constants. Undefined means "use scoring/consensusBandit.ts's live defaults." */
    private banditConfig?: BanditConfigOverride,
    /** Optional -- the equivalent sweep knob for the session-performance gate that superseded the bandit leg. Undefined means "use scoring/sessionPerformance.ts's live defaults." */
    private sessionPerformanceConfig?: SessionPerformanceConfigOverride,
  ) {
    this.equity = new Decimal(startingEquity);
    this.peakEquity = this.equity;
    this.dailyStartingEquity = this.equity;
  }

  // ---- Synthetic-account bookkeeping, driven by runReplay ----

  /**
   * Must be called once per bar, BEFORE resolving that bar's exits or
   * opening a new position — day-rollover has to see equity as it stood at
   * the END of the previous bar, not after this bar's own trade events have
   * already touched it, or dailyStartingEquity captures the wrong instant.
   */
  advanceTo(at: Date): void {
    const dayKey = at.toISOString().slice(0, 10); // UTC calendar day, same boundary as computeAccountRiskState's todayStart
    if (this.currentDayKey !== dayKey) {
      this.currentDayKey = dayKey;
      // Mark-to-market, not realized-only -- live's dailyStartingEquity
      // comes from the first equityCurvePoint of the day, which is itself
      // computeAccountEquity's full (realized + unrealized) figure.
      this.dailyStartingEquity = this.equity.plus(this.unrealizedPnl());
      this.consecutiveLosses = 0;
      this.tradesToday = 0;
    }
  }

  markOpen(symbol: string, position: OpenPositionMarker): void {
    this.openPositions.set(symbol, position);
  }

  markClosed(symbol: string): void {
    this.openPositions.delete(symbol);
  }

  /** Called once per bar for every symbol (open or not) so mark-to-market always has a recent price to work from. */
  updateLastPrice(symbol: string, price: Decimal): void {
    this.lastPrice.set(symbol, price);
  }

  recordTradeOpened(): void {
    this.tradesToday++;
  }

  /**
   * Realized-only -- unrealized P&L on still-open positions is added
   * separately in accountState/unrealizedPnl below, using each symbol's
   * latest known price. peakEquity is intentionally NOT touched here
   * anymore; see accountState, which ratchets it off the mark-to-market
   * total every time it's read, matching live's continuous
   * (onPriceTick-driven) equity-curve sampling instead of only updating on
   * realized trade closes.
   */
  recordTradeClosed(pnl: number): void {
    this.equity = this.equity.plus(pnl);
    if (pnl < 0) this.consecutiveLosses++;
    else this.consecutiveLosses = 0;
  }

  /**
   * Sum of every open position's floating P&L at its symbol's latest known
   * price. FIDELITY NOTE: live's computeOpenUnrealizedPnl marks to market on
   * every price tick (~5-10s); this only has whatever bar resolution
   * barsBySymbol was loaded at, and only updates when that symbol's own bar
   * is processed (see runReplay's updateLastPrice call) -- so a fast, large
   * move on one symbol between its own bars won't move another symbol's
   * circuit-breaker check as promptly as it would live. Closer than pure
   * realized-only, not identical.
   */
  private unrealizedPnl(): Decimal {
    let total = new Decimal(0);
    for (const [symbol, position] of this.openPositions) {
      const price = this.lastPrice.get(symbol) ?? position.entryPrice;
      const direction = position.side === "long" ? 1 : -1;
      total = total.plus(price.minus(position.entryPrice).times(direction).times(position.pointValue).times(position.quantity));
    }
    return total;
  }

  // ---- Degradation tracking ----
  // Sparse/missing historical coverage is a silent-lie risk (see
  // replay-harness.md's "fidelity limits: report, don't hide") -- these
  // accumulate here and decideOnBar drains them via contextDegradations()
  // right after calling dailyTrend/dailyEmaTrend/newsRisk.

  private pendingDegradations: string[] = [];

  contextDegradations(): string[] {
    const drained = this.pendingDegradations;
    this.pendingDegradations = [];
    return drained;
  }

  /** Lazy, cached per instance (once per replay run, not once per bar) -- prisma.newsEvent.count() every bar would be needlessly expensive for a fact that doesn't change mid-run. */
  private newsEventCoverageChecked = false;
  private newsEventCoverageExists = true;

  /** Full daily-bar history per symbol, fetched once and filtered in-memory per call thereafter -- see filterDailyBarsAsOf's comment. */
  private dailyBarsCache = new Map<string, OhlcBar[]>();

  private async getDailyBarsForSymbol(symbol: string): Promise<OhlcBar[]> {
    const cached = this.dailyBarsCache.get(symbol);
    if (cached) return cached;
    const rows = await prisma.dailyBar.findMany({ where: { symbol }, orderBy: { date: "asc" } });
    const bars = rows.map((r) => ({
      time: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
    }));
    this.dailyBarsCache.set(symbol, bars);
    return bars;
  }

  // ---- DecisionContext ----

  async recentBars(symbol: string, count: number, at: Date): Promise<OhlcBar[]> {
    const bars = this.barsBySymbol.get(symbol) ?? [];
    // Ascending history ending at the just-closed bar (at) -- strictly
    // excludes anything at or after `at` itself in case of duplicate
    // timestamps in the source data.
    const upToAt = bars.filter((b) => b.time.getTime() <= at.getTime());
    return upToAt.slice(Math.max(0, upToAt.length - count));
  }

  async dailyTrend(symbol: string, at: Date): Promise<RegimeResult> {
    const all = await this.getDailyBarsForSymbol(symbol);
    const bars = filterDailyBarsAsOf(all, at, DAILY_TREND_LOOKBACK_DAYS);
    if (bars.length === 0) this.pendingDegradations.push("dailyBarsMissing");
    return classifyRegime(bars);
  }

  async dailyEmaTrend(symbol: string, at: Date): Promise<EmaTrend> {
    const all = await this.getDailyBarsForSymbol(symbol);
    const bars = filterDailyBarsAsOf(all, at, DAILY_EMA_LOOKBACK_DAYS);
    if (bars.length === 0) this.pendingDegradations.push("dailyBarsMissing");
    return classifyEmaTrend(bars, DAILY_EMA_PERIOD);
  }

  async newsRisk(at: Date): Promise<NewsRiskStatus> {
    // getNewsRiskStatus is already parameterized by `at` and bounds its own
    // query symmetrically around it (news/risk.ts) -- no separate as-of
    // implementation needed, unlike the caches above. It DOES require
    // prisma.newsEvent to actually have historical coverage for the replay
    // window, though -- with none, every bar just silently reads "no risk."
    // Checked once per run (not once per bar -- the answer can't change
    // mid-run) rather than trusting inRiskWindow:false to mean the same
    // thing as "there was no data to check."
    if (!this.newsEventCoverageChecked) {
      this.newsEventCoverageChecked = true;
      const anyEvent = await prisma.newsEvent.findFirst({ select: { id: true } });
      this.newsEventCoverageExists = anyEvent !== null;
    }
    if (!this.newsEventCoverageExists) {
      this.pendingDegradations.push("newsEventDataMissing");
      // No NewsEvent rows exist at all -- getNewsRiskStatus's own query would
      // always return this same "no risk" shape (news/risk.ts: zero matches
      // -> inRiskWindow: false), so skip the guaranteed-empty per-bar DB
      // round trip entirely rather than pay for it ~7,600 times over a
      // multi-week replay window for a result we already know.
      return { inRiskWindow: false, nearestEventName: null, nearestEventTime: null, minutesToEvent: null, impact: null };
    }
    return getNewsRiskStatus(at);
  }

  async openingRange(symbol: string, at: Date): Promise<OpeningRangeStats> {
    // Live computes this from bars_1m (real tick-aggregated 1-minute bars).
    // Replay only has whatever resolution barsBySymbol was loaded at (5m
    // Yahoo bars per CLAUDE.md's stated constraint) -- computeOpeningRangeStats
    // itself is resolution-agnostic, but a 5m-bar opening range is a coarser
    // read of "did the first hour's high/low break" than live's 1m data
    // gets. Reported here, not hidden.
    let instrument;
    try {
      instrument = getInstrument(symbol);
    } catch {
      return { symbol, sessionsAnalyzed: 0, probHighBroken: null, probLowBroken: null, probBothBroken: null, probNeitherBroken: null };
    }
    const bars = this.barsBySymbol.get(symbol) ?? [];
    const upToAt = bars.filter((b) => b.time.getTime() < at.getTime());
    return computeOpeningRangeStats(upToAt, symbol, instrument.rthOpenHourET, instrument.rthOpenMinuteET);
  }

  async fixedTargetEdge(
    symbol: string,
    session: TradingSession,
    side: "long" | "short",
    at: Date,
  ): Promise<{ winRate: number | null; sampleSize: number } | null> {
    return computeFixedTargetEdge(symbol, session, side, at);
  }

  orderFlow(): null {
    // CDP order flow cannot be backfilled -- always null in replay, always
    // tagged in decideOnBar's degraded[] list. See replay-harness.md.
    return null;
  }

  accountState(at: Date): AccountRiskState {
    this.advanceTo(at);
    const currentEquity = this.equity.plus(this.unrealizedPnl());
    // Ratcheted here rather than only in recordTradeClosed -- live's peak
    // comes from continuously-sampled equity-curve points (onPriceTick,
    // every ~5-10s), not just realized trade closes, so a peak reached while
    // a position was still open and floating would already count live.
    this.peakEquity = Decimal.max(this.peakEquity, currentEquity);
    return {
      currentEquity,
      peakEquity: this.peakEquity,
      dailyStartingEquity: this.dailyStartingEquity,
      consecutiveLosses: this.consecutiveLosses,
      tradesToday: this.tradesToday,
    };
  }

  executionSettings(): ExecutionSettings {
    return this.settings;
  }

  riskLimits(): RiskLimitsConfig {
    return this.limits;
  }

  async hasOpenPosition(symbol: string): Promise<boolean> {
    return this.openPositions.has(symbol);
  }

  async hasConflictingPosition(symbol: string, side: "long" | "short"): Promise<boolean> {
    const partnerSymbol = getConflictingPartnerSymbol(symbol);
    if (!partnerSymbol) return false;
    const partnerPosition = this.openPositions.get(partnerSymbol);
    return partnerPosition !== undefined && partnerPosition.side !== side;
  }

  // Calls the UNCACHED core directly, every time -- unlike
  // LiveDecisionContext, which goes through engine/consensusBanditCache.ts's
  // wall-clock TTL cache. A cache keyed only by bucket (ignoring `at` for
  // cache-hit purposes) is correct for live, where callers only ever call
  // "now" -- but a replay run walks many distinct `at` values across a
  // historical window, and a stale cache hit would silently return a
  // wrong-`at` selection. Same reasoning as computeFixedTargetEdge's own
  // export comment.
  async banditVersionSelection(bucket: string, at: Date): Promise<BanditSelectionResult> {
    if (this.banditConfig?.forceColdStart) {
      return { bucket, selectedVersion: CONSENSUS_BANDIT_ARMS[0]!, coldStart: true, armStats: new Map(), armScores: new Map() };
    }
    return computeBanditSelection(bucket, at, this.banditConfig?.explorationConstant, this.banditConfig?.minBucketSamples, this.banditConfig?.minPerArmSamples);
  }

  // Same "calls the uncached core directly" reasoning as banditVersionSelection
  // above -- a replay run walks many distinct `at` values, so a wall-clock
  // cache would silently return a wrong-session selection.
  async sessionPerformanceSelection(at: Date): Promise<SessionPerformanceSelection> {
    const sessionStart = getSessionStart(at);
    if (this.sessionPerformanceConfig?.forceColdStart) {
      return { sessionStart, selectedVersion: SESSION_PERFORMANCE_ARMS[0]!, coldStart: true, statsByVersion: new Map() };
    }
    return computeSessionPerformanceSelection(sessionStart, at, this.sessionPerformanceConfig?.minSamplesPerVersion);
  }

  // CBOE's historical options chain cannot be backfilled -- always null in
  // replay, same fidelity limit as orderFlow above. risk/engine.ts's
  // dealer-level gate fails open on null, so this never invents a
  // rejection replay-vs-live would disagree on; decideOnBar's degraded[]
  // tracking is what makes this gap visible rather than hidden.
  async dealerLevels(): Promise<DealerLevelResult | null> {
    return null;
  }

  // Always empty -- see DecisionContext.dailyPlanZones's own comment for why
  // this is a different kind of limitation than dealerLevels/orderFlow
  // above (not a fidelity gap; an LLM-authored "today's plan" simply has no
  // meaning for a historical replay date).
  async dailyPlanZones(): Promise<DailyPlanZone[]> {
    return [];
  }

  // Always empty -- see DecisionContext.disabledStrategyIds's own comment.
  async disabledStrategyIds(): Promise<Set<string>> {
    return new Set();
  }

  // Always empty -- see DecisionContext.disabledSymbols's own comment.
  async disabledSymbols(): Promise<Set<string>> {
    return new Set();
  }

  // Always empty -- see DecisionContext.disabledStrategySymbolPairs's own comment.
  async disabledStrategySymbolPairs(): Promise<Set<string>> {
    return new Set();
  }
}
