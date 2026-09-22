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
import type { BrokerClient, ClosedSimTrade, ClosedTradeHistoryEntry } from "../brokers/types.js";
import { getBroker } from "../brokers/index.js";
import { findMatchingClosedTrade } from "../browserControl/tradeHistoryPanel.js";
import { SimulatedBroker } from "../brokers/simulatedBroker.js";
import { computeAccountEquity, computeAccountRiskState, recordEquityPoint } from "./accounting.js";
import { ensureAccountForBrokerId, ensureAccountForBrokerKind, ensureDefaultAccount, loadRecentBars } from "./bootstrap.js";
import { getLatestBrowserAccountSnapshot } from "./liveAccountOverride.js";
import { classifySession, TradingSession } from "../analytics/session.js";
import { computeContextBucket } from "../analytics/contextBucket.js";
import { computeSmartEntryPrice } from "../analytics/smartEntry.js";
import { CONSENSUS_BANDIT_ARMS, type BanditSelectionResult } from "../scoring/consensusBandit.js";
import type { SessionPerformanceSelection } from "../scoring/sessionPerformance.js";
import { getSessionPerformanceSelection } from "./sessionPerformanceCache.js";
import { getSessionSwitchingSelection } from "./sessionSwitchingAgentCache.js";
import { getDealerLevels } from "./dealerGexCache.js";
import { getActiveDailyPlanZones } from "./dailyPlanZoneCache.js";
import { getAssistantTakeProfitCapPoints, resolveHardTakeProfitDollars } from "./dailyPlanTakeProfitCache.js";
import { hasConflictingCrossSymbolPosition as hasConflictingCrossSymbolPositionCheck } from "./crossSymbolConflictCheck.js";
import { getDisabledStrategyIds } from "./strategyEnablementCache.js";
import { getDisabledSymbols } from "./symbolEnablementCache.js";
import { getDisabledStrategySymbolPairs, strategySymbolKey } from "./strategySymbolEnablementCache.js";
import { logShadowGexSignal } from "./shadowGexSignalLogger.js";
import { getDailyTrend } from "./dailyTrendCache.js";
import { getDailyEma20Trend } from "./dailyEmaTrendCache.js";
import { getFixedTargetEdge } from "./fixedTargetEdgeCache.js";
import { getLatestOrderFlowSnapshot } from "./liveOrderFlowCache.js";
import { setLatestRegimeSnapshot } from "./regimeSnapshotCache.js";
import { getOpeningRangeStats } from "./openingRangeCache.js";
import { explainKillSwitch, explainRiskRejection, explainScore, explainTradeExit } from "../explain/engine.js";
import { executeIfApproved } from "../execution/engine.js";
import { getExecutionSettings, getSystemState, tripKillSwitch } from "../execution/mode.js";
import { getInstrument, type InstrumentSpec } from "../marketData/instruments.js";
import { getNewsRiskStatus } from "../news/risk.js";
import { classifyRegime } from "../regime/classifier.js";
import type { RegimeResult } from "../regime/classifier.js";
import { atr as computeAtr, type OhlcBar } from "../regime/indicators.js";
import {
  computeInitialStop,
  hasReachedTrailingStopActivation,
  RiskEngine,
  reanchorBracketToRealEntry,
  resolveTrailingStopDistanceTicks,
  REQUIRE_DAILY_PLAN_SYMBOLS,
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

// S/R proximity gate temporary suspension (2026-08-06, operator request,
// 24h-boxed): the v6-solo execution gate (see V6_SOLO_EXECUTION_THRESHOLD
// below) started clearing signals at 30% that were then immediately vetoed
// by risk/engine.ts's MAX_ENTRY_DISTANCE_ATR/MIN_ENTRY_DISTANCE_ATR band
// (concrete example: an ES short at v6=30% approved by consensus, then
// rejected for sitting 2.43x ATR from the nearest resistance level, needing
// 1.95x) -- the same tension documented at length in that file's own
// comment history. Rather than pick a new permanent band with no evidence
// behind it, the operator asked to suspend the distance check entirely for
// 24 hours to see what it actually costs/gains, and revisit with real data.
// The S/R *validation* requirement (a real 2+-touch level must still exist
// nearby) is untouched -- only the distance-from-it band is suspended. This
// lives here (wall-clock/DB-coupled), not in risk/engine.ts, which stays
// pure per CLAUDE.md -- assessNewTrade only ever receives the already-
// computed boolean.
const SR_PROXIMITY_GATE_SUSPENDED_UNTIL = Date.parse("2026-08-08T04:35:00Z");

export function isSrProximityGateSuspended(at: Date): boolean {
  return at.getTime() < SR_PROXIMITY_GATE_SUSPENDED_UNTIL;
}

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
// v7 (2026-08-07, see scoring/ruleScorerV7.ts) joins the same way -- pattern-
// mined from real resolved outcomes, zero live trades behind its own weight
// yet, shadow-only until it earns promotion on a real track record. Unlike
// v6, it needs no other version's results (plain features in, points out --
// see gate.ts's "v7" branch), so ordering relative to v5/v6 here doesn't
// matter.
const SHADOW_ONLY_VERSIONS: StrategyVersion[] = ["v5", "v6", "v7"];

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
// confirms. Applied identically to both real-strategy signals
// (determineConsensus) and continuous-scan signals
// (determineContinuousScanConsensus).
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
// v7 appended (2026-08-07, same day as the v7-solo gate below): without it, a
// trade that executes purely because v7 cleared its own solo gate -- with
// none of v6/v3/v2/v1/v5 independently reading "taken" on that signal --
// fell through to V6_MANDATORY_REPRESENTATIVE_ORDER[0] ("v6") by default,
// showing v6's explanation as representative even though v6 had nothing to
// do with why the trade fired.
const V6_MANDATORY_REPRESENTATIVE_ORDER: StrategyVersion[] = ["v6", "v3", "v2", "v1", "v5", "v7"];

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

// v6-solo gate (2026-08-06, operator request): v6 alone clearing the
// threshold is enough to execute -- no confirmation from v1/v2/v3/v5
// required at all. Replaces the v6-mandatory-plus-one-confirmation rule
// above the same way that rule replaced hasMutualAgreement -- SUPERSEDED,
// not deleted, so the prior rule is a one-line swap back
// (`hasV6MandatoryAgreement` / `v6MandatorySummary`) if this doesn't hold
// up. Operator's explicit, informed call after being told: v6 had zero
// resolved live trades behind its own weight at the time of this change
// (see the v6-mandatory-gate comment above), the original 30% is below a
// coin flip, and this removes the only other-model-confirmation requirement
// the previous two consensus rules both kept in some form. No evidence
// backed 30% specifically -- watch this deployment's actual win rate once
// real trades accumulate under it.
// 2026-08-07: lowered 30% -> 29.55% -> 29.5%. First hop: a real NQ long
// scored v6=29.773% -- displayed as "30%" everywhere (whole-percent
// rounding, since fixed, see explain/engine.ts's explainScore comment) and
// read as a bug ("this should've executed") when the gate was actually
// working correctly against the unrounded value. Second hop, same day,
// operator request: v3's own solo gate (the 29.5% number, see the now-
// superseded hasV3SoloAgreement below) was retired in favor of v3 going back
// to the plain v1.2-era majority vote (hasV1V2V3MajorityAgreement below) --
// v6 is now the sole owner of "the 29.5% number." No backtested evidence
// behind 29.5% -- same caveat as the original 30%/29.55% above.
const V6_SOLO_EXECUTION_THRESHOLD = 0.295;

function hasV6SoloAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>): boolean {
  return gatedByVersion.get("v6")!.probability >= V6_SOLO_EXECUTION_THRESHOLD;
}

function v6SoloSummary(gatedByVersion: Map<StrategyVersion, GatedScore>, averageProbability: number): string {
  const v6Probability = gatedByVersion.get("v6")!.probability;
  // One decimal place, not Math.round -- see explain/engine.ts's explainScore
  // comment (2026-08-07) for why whole-percent rounding is no longer safe
  // once a threshold itself (29.5%) isn't a round number either.
  return (
    `v6-solo gate: v6 needs ${(V6_SOLO_EXECUTION_THRESHOLD * 100).toFixed(1)}%+ alone, no other version required ` +
    `(v6=${(v6Probability * 100).toFixed(1)}%, avg v1/v2/v3=${(averageProbability * 100).toFixed(1)}%): ` +
    `${ALL_FOUR_VERSIONS.map((v) => `${v}=${(gatedByVersion.get(v)!.probability * 100).toFixed(1)}%`).join(", ")}`
  );
}

// v3-solo gate (2026-08-07, operator request, additive alongside v6-solo
// above at the time) -- SUPERSEDED the same day, not deleted: the operator
// asked v3 to go back to the plain "tera trade 1.2" majority-vote rule
// instead (hasV1V2V3MajorityAgreement below) rather than keep its own solo
// threshold. Left here, unused, so reverting is a one-line swap back in
// determineConsensus if the 1.2-rules choice doesn't hold up. Was: v3 alone
// clearing 29.5% is enough to execute on its own, no confirmation from any
// other version required.
const V3_SOLO_EXECUTION_THRESHOLD = 0.295;

function hasV3SoloAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>): boolean {
  return gatedByVersion.get("v3")!.probability >= V3_SOLO_EXECUTION_THRESHOLD;
}

// v1/v2/v3 majority vote, "tera trade 1.2 rules" (2026-08-07, operator
// request): v3 no longer gets its own solo threshold (see the superseded
// hasV3SoloAgreement above) -- instead it goes back to the straight
// majority-vote rule this project shipped 1.2 under (2026-07-16 -- see this
// file's very first STRATEGY_VERSIONS comment, never actually deleted from
// here even though the enforcing code was replaced several times since): at
// least 2 of the 3 versions' probabilities individually clear the 65% score
// threshold (LOOSE_GATE_THRESHOLD). No v5/v6/v7 involvement in this leg at
// all -- those are separate, independently-OR'd gates in determineConsensus.
//
// SUPERSEDED (2026-08-09, operator request), not deleted -- kept as the
// cold-start fallback hasBanditSelectedVersionAgreement below reverts to
// whenever a bucket doesn't yet have enough resolved history to trust the
// bandit. A fixed rule applied identically regardless of session/trend/
// volatility was replaced with a learned, per-market-condition policy (see
// scoring/consensusBandit.ts) -- this function itself is unchanged and still
// the actual enforcement whenever the bandit can't yet make an informed
// pick.
function hasV1V2V3MajorityAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>): boolean {
  return STRATEGY_VERSIONS.filter((v) => gatedByVersion.get(v)!.probability >= LOOSE_GATE_THRESHOLD).length >= 2;
}

// Contextual UCB1 bandit leg (2026-08-09, operator request, replacing
// hasV1V2V3MajorityAgreement's fixed rule above as one of the three OR'd legs
// of determineConsensus): per (session x intraday-trend x intraday-vol)
// bucket (analytics/contextBucket.ts), picks whichever single one of
// CONSENSUS_BANDIT_ARMS (v1/v2/v3/v6/v7 -- widened same day from v1/v2/v3
// only, see scoring/consensusBandit.ts's own comment) has actually performed
// best in that exact bucket historically (Score.outcomeRMultiple,
// UCB1-selected) and gates on that version alone at the same
// LOOSE_GATE_THRESHOLD the majority vote used. Falls back to the plain
// majority vote verbatim (`banditSelection.coldStart`) until a bucket has
// enough resolved samples to trust (scoring/consensusBandit.ts's
// MIN_BUCKET_SAMPLES_BEFORE_BANDIT/MIN_PER_ARM_SAMPLES_BEFORE_BANDIT).
// hasV6SoloAgreement/hasV7SoloAgreement below remain separate, untouched
// OR'd legs -- v6 and v7 being bandit arms here is additive, not a
// replacement for their own solo gates. Operator's explicit, informed call
// to go live with this immediately, no shadow-only validation period -- same
// posture as v6-solo/v7-solo's own promotions; no backtested evidence behind
// the bandit's own constants specifically (see scripts/replayBanditEval.ts
// for the walk-forward evaluation meant to follow, not precede, this).
function hasBanditSelectedVersionAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>, banditSelection: BanditSelectionResult): boolean {
  if (banditSelection.coldStart) return hasV1V2V3MajorityAgreement(gatedByVersion);
  return gatedByVersion.get(banditSelection.selectedVersion)!.probability >= LOOSE_GATE_THRESHOLD;
}

// Session-best-version gate (2026-08-10, operator request) -- SUPERSEDES the
// entire three-way OR above (hasV6SoloAgreement / hasBanditSelectedVersionAgreement
// / hasV7SoloAgreement), not just the bandit leg: "automatically switch to
// the highest performing model based on its winning score for the session,
// even a one-point edge -- automatically use that version." The operator was
// shown three options directly -- (a) use the contextual UCB1 bandit above,
// (b) replace the agreement requirement with a single best-performing
// version as the sole gate, (c) keep the agreement requirement and only use
// performance as a representative-version tie-break -- and chose (b): ONE
// version, whichever has the best realized win rate over the CURRENT
// trading session (scoring/sessionPerformance.ts, resets at each session
// boundary), gates alone at the same LOOSE_GATE_THRESHOLD the majority vote
// and bandit leg both used. No minimum margin -- a strict `>` in
// selectSessionBestVersion means the next resolved score can flip which
// version is "best" and therefore which version gates, immediately.
//
// v6-solo and v7-solo's own separate low-threshold escape hatches (29.5%/
// 65% alone, independent of session performance) are also superseded here,
// not layered alongside this -- the operator's framing was "the sole gate,"
// not "one more OR'd leg." All three superseded functions above are kept,
// unused, so reverting is a one-line swap back in determineConsensus.
//
// v7-solo REACTIVATED (2026-08-11, separate, later operator request: "v7 is
// still in shadow mode only and i want it to be executable on live trading
// now i understand the risk"). Confirmed for the operator first that v7 was
// already eligible to gate a trade on its own via THIS session-best-version
// mechanism once it had session evidence and was winning -- that wasn't
// enough; the ask was for v7 to be able to fire on its own merit
// unconditionally, the same guarantee v6-solo/the old v7-solo gate gave
// v6/v7 before this rule superseded them. determineConsensus now ORs
// hasV7SoloAgreement back in alongside this gate (not instead of it) --
// v6-solo and the old bandit leg stay superseded/unused; this request named
// v7 specifically, not v6, so only v7's escape hatch comes back.
//
// Cold-start fallback (fewer than MIN_SESSION_SAMPLES_PER_VERSION resolved
// samples this session for every version -- true for the first few setups of
// every session) reuses hasV1V2V3MajorityAgreement verbatim, same safety
// posture as the bandit leg's own cold-start: with zero session evidence yet,
// "highest win rate" is meaningless, so this falls back to requiring 2 of 3
// independent versions to agree rather than crowning an arbitrary winner.
function hasSessionBestVersionAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>, sessionSelection: SessionPerformanceSelection): boolean {
  if (sessionSelection.coldStart) return hasV1V2V3MajorityAgreement(gatedByVersion);
  return gatedByVersion.get(sessionSelection.selectedVersion)!.probability >= LOOSE_GATE_THRESHOLD;
}

function sessionPerformanceSummary(gatedByVersion: Map<StrategyVersion, GatedScore>, averageProbability: number, sessionSelection: SessionPerformanceSelection, session: TradingSession): string {
  const v7Probability = gatedByVersion.get("v7")!.probability;
  const v6V7OnlySession = isV6V7OnlySession(session);
  // "regardless of session standing" is no longer true during Asian
  // (2026-08-17, "v7 shouldn't fire in asia ever") -- the note itself now
  // says so instead of overclaiming what v7SoloPassed will actually do.
  const v7SoloNote = v6V7OnlySession
    ? `, v7-solo escape hatch disabled this session (v7=${(v7Probability * 100).toFixed(1)}%) -- v7 must win the session-best-version gate below instead`
    : `, OR v7 needs ${(V7_SOLO_EXECUTION_THRESHOLD * 100).toFixed(0)}%+ alone regardless of session standing (v7=${(v7Probability * 100).toFixed(1)}%)`;
  const restrictionNote = v6V7OnlySession
    ? ` [${session} session: execution restricted to v6/v7 only -- any other version's agreement is not honored]`
    : "";
  if (sessionSelection.coldStart) {
    const coldStartFallbackNote = v6V7OnlySession
      ? `the v1/v2/v3 majority-vote fallback is blocked entirely this session (only v6 or v7 may execute)`
      : `falling back to plain v1/v2/v3 majority vote (needs 2 of 3 at ${Math.round(LOOSE_GATE_THRESHOLD * 100)}%+, avg=${(averageProbability * 100).toFixed(1)}%)`;
    return (
      `session-best-version gate: cold-start (fewer than the resolved-sample floor this session for every version), ` +
      `${coldStartFallbackNote}${v7SoloNote}${restrictionNote}: ` +
      `${CONSENSUS_SUMMARY_VERSIONS.map((v) => `${v}=${(gatedByVersion.get(v)!.probability * 100).toFixed(1)}%`).join(", ")}`
    );
  }
  const statsSummary = [...sessionSelection.statsByVersion.values()]
    .map((s) => `${s.version}=${(s.winRate * 100).toFixed(1)}%win(n=${s.resolvedCount})`)
    .join(", ");
  const selectedProbability = gatedByVersion.get(sessionSelection.selectedVersion)!.probability;
  const selectionHonoredNote =
    v6V7OnlySession && sessionSelection.selectedVersion !== "v6" && sessionSelection.selectedVersion !== "v7"
      ? ` -- NOT honored (not v6/v7)`
      : "";
  return (
    `session-best-version gate: session started ${sessionSelection.sessionStart.toISOString()}, ` +
    `best performer this session is ${sessionSelection.selectedVersion} (needs ${Math.round(LOOSE_GATE_THRESHOLD * 100)}%+ alone, ` +
    `scored ${(selectedProbability * 100).toFixed(1)}% on this setup)${selectionHonoredNote}${v7SoloNote}${restrictionNote} -- session win rates: ${statsSummary}`
  );
}

// v7-solo gate (2026-08-07, operator request, additive alongside v6-solo and
// the v1/v2/v3 majority vote above, not a replacement): v7 alone clearing
// 65% is enough to execute on its own -- no confirmation from any other
// version required, including v6 (an initial "v7 needs 65% AND v6 needs
// 29.5%" shape was proposed and explicitly walked back the same exchange --
// v6's score does not factor into this gate at all). A materially higher bar
// than v6-solo's 29.5% -- v7 was shadow-only up to this point (see
// SHADOW_ONLY_VERSIONS' comment; zero live trades behind its own weight,
// same starting position v6 was in before its own promotion) and the
// operator chose to promote it at a stricter threshold rather than reuse the
// ~29.5% pattern. No backtested evidence behind 65% specifically -- same
// caveat as the other gates; watch this deployment's actual results.
const V7_SOLO_EXECUTION_THRESHOLD = 0.65;

// This function itself is unchanged and still session-agnostic -- the
// Asian-session block (2026-08-17, "v7 shouldn't fire in asia ever") is
// applied at the call site in determineConsensus (v7SoloPassed), not here,
// so hasV7SoloAgreement stays a pure "did v7 clear its own bar" read usable
// elsewhere without silently baking in a session assumption.
function hasV7SoloAgreement(gatedByVersion: Map<StrategyVersion, GatedScore>): boolean {
  return gatedByVersion.get("v7")!.probability >= V7_SOLO_EXECUTION_THRESHOLD;
}

// All versions ever referenced by a gate below, for the summary string --
// ALL_FOUR_VERSIONS deliberately stays v1/v2/v3/v5 (still used by
// hasAnySingleVersionAgreement's dormant-but-kept-callable rule above), so
// this is its own list rather than widening that one's meaning.
const CONSENSUS_SUMMARY_VERSIONS: StrategyVersion[] = ["v1", "v2", "v3", "v5", "v6", "v7"];

function consensusRuleSummary(gatedByVersion: Map<StrategyVersion, GatedScore>, averageProbability: number, banditSelection: BanditSelectionResult): string {
  const v6Probability = gatedByVersion.get("v6")!.probability;
  const v7Probability = gatedByVersion.get("v7")!.probability;
  const majorityAgreeing = STRATEGY_VERSIONS.filter((v) => gatedByVersion.get(v)!.probability >= LOOSE_GATE_THRESHOLD);
  const banditLeg = banditSelection.coldStart
    ? `bandit leg: bucket "${banditSelection.bucket}" cold-start, falling back to plain v1/v2/v3 majority vote`
    : `bandit leg: bucket "${banditSelection.bucket}" selected ${banditSelection.selectedVersion} of [${CONSENSUS_BANDIT_ARMS.join("/")}] (needs ${Math.round(LOOSE_GATE_THRESHOLD * 100)}%+ alone)`;
  return (
    `v6-solo-or-bandit-leg-or-v7-solo gate: v6 needs ${(V6_SOLO_EXECUTION_THRESHOLD * 100).toFixed(1)}%+ alone, ` +
    `OR the ${banditLeg}, ` +
    `OR v7 needs ${(V7_SOLO_EXECUTION_THRESHOLD * 100).toFixed(0)}%+ alone ` +
    `(v6=${(v6Probability * 100).toFixed(1)}%, v7=${(v7Probability * 100).toFixed(1)}%, avg v1/v2/v3=${(averageProbability * 100).toFixed(1)}%): ` +
    `${CONSENSUS_SUMMARY_VERSIONS.map((v) => `${v}=${(gatedByVersion.get(v)!.probability * 100).toFixed(1)}%`).join(", ")}` +
    (majorityAgreeing.length > 0 ? `, 65%+ agreeing: ${majorityAgreeing.join(", ")}` : "")
  );
}

// Asian-only execution restriction (2026-08-13, operator request: "block all
// executions during Asian session... only execute v6 or v7 during asian and
// london session", corrected same day: "the only session it should block is
// asia until londons session starts" -- London is NOT restricted, only
// Asian is). New York and London are both unaffected -- no change to any
// rule above this point. Implemented as a narrowing filter on
// determineConsensus's own sessionGatePassed below, not a new standalone
// gate: the session-best-version gate can select ANY of v1/v2/v3/v6/v7 (or,
// on a cold start, fall back to a v1/v2/v3 majority vote with no single
// driving version at all), so during Asian that selection is only honored
// when the selected version is v6 or v7 -- any other selection is treated
// as if the gate hadn't passed. v6 keeps its existing single path to
// executing alone here (being this session's best performer) rather than
// gaining a new, separate solo gate the operator didn't ask for.
//
// v7-solo ALSO now blocked during Asian (2026-08-17, operator request: "v7
// shouldn't fire in asia ever") -- SUPERSEDES this function's original
// comment above, which said v7-solo was untouched/fired every session
// (true from 2026-08-11 reactivation until this change). See v7SoloPassed's
// own gating in determineConsensus below.
//
// Turned off (2026-09-01, operator request: "turn that Asia restriction
// off") -- SUPERSEDES both comments above; real trigger was a concrete
// missed setup, not a hunch: a NQ short during Asian scored v1=91.2%,
// v2=93.0%, v3=72.8% (all three individually clearing 65%, genuinely
// agreeing with each other) but got rejected outright because v1 -- this
// session's best performer on that setup -- isn't v6 or v7, and v7 itself
// only hit 49.2%. Asian now uses the exact same session-best-version + v7-solo
// rule as London/New York, no session-specific carve-out. Kept as a
// function (not deleted at every call site) in case a future request wants
// this narrowed to some OTHER session -- always returning false is the
// complete "off" state; flip it back to `session === TradingSession.ASIAN`
// (or a different session) to re-enable, same call sites as before.
function isV6V7OnlySession(_session: TradingSession): boolean {
  return false;
}

export function determineConsensus(gatedByVersion: Map<StrategyVersion, GatedScore>, sessionSelection: SessionPerformanceSelection, session: TradingSession): ConsensusDecision {
  const probabilities = STRATEGY_VERSIONS.map((v) => gatedByVersion.get(v)!.probability);
  const averageProbability = probabilities.reduce((a, b) => a + b, 0) / probabilities.length;

  const rawSessionGatePassed = hasSessionBestVersionAgreement(gatedByVersion, sessionSelection);
  const v6V7OnlySession = isV6V7OnlySession(session);
  const sessionGateDrivenByV6OrV7 =
    rawSessionGatePassed && !sessionSelection.coldStart && (sessionSelection.selectedVersion === "v6" || sessionSelection.selectedVersion === "v7");
  // Redefines what "the session gate passed" means for everything below
  // (representativeOrder included) whenever v6V7OnlySession is true, so the
  // rest of this function doesn't need its own separate v6/v7-only branch.
  const sessionGatePassed = v6V7OnlySession ? sessionGateDrivenByV6OrV7 : rawSessionGatePassed;
  // Blocked entirely during Asian (2026-08-17, operator request: "v7
  // shouldn't fire in asia ever") -- previously fired in every session
  // regardless of v6V7OnlySession (2026-08-11 reactivation, see
  // hasV7SoloAgreement's own comment), including as the one carve-out that
  // could execute even when the session-best-version gate picked a
  // non-v6/v7 version. That carve-out is gone: in Asian, v7 must now win the
  // session-best-version gate like v6 does, or nothing v7-driven executes.
  const v7SoloPassed = !v6V7OnlySession && hasV7SoloAgreement(gatedByVersion);
  const taken = sessionGatePassed || v7SoloPassed;

  // Prefer a version that itself agrees ("taken") for the most meaningful
  // representative explanation, falling back to the order's first entry if
  // none of the candidates' own decision happens to read "taken" (possible
  // since a version's own gate decision can be blocked by its own additional
  // checks -- e.g. v3's directional-conviction margin -- even when its raw
  // probability contributed to agreement here). The session-selected
  // version leads when its own gate is what fired (the entire reason this
  // trade fired); v7 leads when it's the v7-solo leg that fired instead
  // (2026-08-11 reactivation, see hasV7SoloAgreement's comment) -- e.g. a
  // session cold-start, or a session where v7 isn't currently "best" but
  // still cleared its own bar alone. Falls back to the v6-first base order
  // otherwise.
  const representativeOrder =
    sessionGatePassed && !sessionSelection.coldStart
      ? [sessionSelection.selectedVersion, ...V6_MANDATORY_REPRESENTATIVE_ORDER.filter((v) => v !== sessionSelection.selectedVersion)]
      : v7SoloPassed
        ? ["v7" as StrategyVersion, ...V6_MANDATORY_REPRESENTATIVE_ORDER.filter((v) => v !== "v7")]
        : V6_MANDATORY_REPRESENTATIVE_ORDER;
  const takenVersions = representativeOrder.filter((v) => gatedByVersion.get(v)!.decision === "taken");
  const representativeVersion = taken ? (representativeOrder.find((v) => takenVersions.includes(v)) ?? representativeOrder[0]!) : null;

  const summary = sessionPerformanceSummary(gatedByVersion, averageProbability, sessionSelection, session);

  return { taken, representativeVersion, averageProbability, summary };
}

// Continuous-scan setups (see scanSymbolContinuously) have no detected chart
// pattern behind them -- unlike a real strategy signal, they're a bar-level
// directional read taken unconditionally on a timer. Shares the exact same
// rule as determineConsensus above (2026-07-14: unified across both signal
// types under mutual-agreement; 2026-08-02: both moved together first to the
// any-single-version gate, then to the v6-mandatory gate -- see those rules'
// comments).
export function determineContinuousScanConsensus(gatedByVersion: Map<StrategyVersion, GatedScore>, sessionSelection: SessionPerformanceSelection, session: TradingSession): ConsensusDecision {
  return determineConsensus(gatedByVersion, sessionSelection, session);
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
  //
  // secondaryBroker/secondaryBrokerKind (added for the Tradesea integration,
  // 2026-08-27) are a SECOND, independent live broker running concurrently
  // with the primary one -- never selected by brokerForMode/mode (mode stays
  // TopstepX's own gate, untouched), only ever passed explicitly as an
  // override to attemptExecution for the second venue's own execution
  // attempt. null when Tradesea isn't configured/connected, in which case
  // every existing single-broker code path behaves exactly as before this
  // pair of params existed.
  constructor(
    private simulatedBroker: SimulatedBroker,
    private liveBroker: BrokerClient | null,
    private liveBrokerKind: BrokerKind | null,
    private eventSink?: EventSink,
    private secondaryBroker: BrokerClient | null = null,
    private secondaryBrokerKind: BrokerKind | null = null
  ) {}

  // 2026-09-10: brokerForTrade's own header comment already documented the intent (manage an
  // existing trade via the broker it actually opened under, never whatever's currently the
  // primary live broker) -- this cache is what makes that possible when a trade's brokerKind
  // doesn't match liveBroker/secondaryBroker/SIMULATED, instead of the previous silent fallthrough
  // to `return this.liveBroker`. Real incident the same day: switching BROKER_KIND from
  // browser_control to projectx left trade #321 (opened under browser_control, no native bracket)
  // routed through the new projectx liveBroker instead -- whose requestClosePosition/
  // flattenPosition were unimplemented at the time -- so its close silently did nothing while its
  // stop was already breached, and the position sat unprotected until manually closed. Cached and
  // connected once per kind (not per call) -- this is read on every price tick for every open
  // trade via manageLiveOpenTrade, and a fresh browser_control connection in particular (a real
  // CDP handshake + tab lookup) is far too slow to redo that often.
  private otherKindBrokers = new Map<BrokerKind, Promise<BrokerClient>>();

  private async getOtherKindBroker(kind: BrokerKind): Promise<BrokerClient> {
    const cached = this.otherKindBrokers.get(kind);
    if (cached) return cached;
    const promise = (async () => {
      const broker = await getBroker(kind);
      await broker.connect();
      return broker;
    })();
    this.otherKindBrokers.set(kind, promise);
    try {
      return await promise;
    } catch (err) {
      this.otherKindBrokers.delete(kind); // don't cache a failed connection attempt -- next call should retry, not rethrow forever
      throw err;
    }
  }

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
  private async brokerForTrade(trade: Trade): Promise<BrokerClient> {
    if (trade.brokerKind === BrokerKind.SIMULATED) return this.simulatedBroker;
    if (this.secondaryBrokerKind && trade.brokerKind === this.secondaryBrokerKind) {
      if (!this.secondaryBroker) throw new Error(`trade #${trade.id} needs broker kind "${trade.brokerKind}" but the secondary broker is not currently connected`);
      return this.secondaryBroker;
    }
    if (this.liveBrokerKind && trade.brokerKind === this.liveBrokerKind) {
      if (!this.liveBroker) throw new Error(`trade #${trade.id} needs broker kind "${trade.brokerKind}" but none is currently connected`);
      return this.liveBroker;
    }
    // trade.brokerKind matches none of the currently-configured brokers (e.g. the operator
    // switched BROKER_KIND after this trade was opened under the old one) -- get/reuse a
    // dedicated connection for that specific kind rather than silently misrouting it through
    // whatever's primary right now. See getOtherKindBroker's own comment for the real incident
    // this replaces.
    return this.getOtherKindBroker(trade.brokerKind as BrokerKind);
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

    // Tradesea's own open positions live under a DIFFERENT accountId than
    // the primary account above -- manageOpenTrades only ever looks at the
    // single account it's given (a plain prisma.trade.findFirst scoped to
    // that accountId), so without this, a Tradesea trade's stop/target would
    // never be monitored at all. Genuinely needs a price tick (stop/target
    // are price-level checks) -- unlike equity recording below, which
    // doesn't and has its own trigger (see recordTradeseaEquitySnapshot).
    if (this.secondaryBroker && this.secondaryBrokerKind) {
      const tradeseaAccount = await ensureAccountForBrokerKind(this.secondaryBrokerKind);
      await this.manageOpenTrades(tradeseaAccount, symbol, time, price, price, price);
      // Redundant-but-harmless alongside recordTradeseaEquitySnapshot's own
      // trigger (index.ts's Tradesea watcher callback) -- both throttle
      // through the same lastEquityPointAt/EQUITY_POINT_MIN_INTERVAL_MS, so
      // whichever fires first in a given window wins and the other is a
      // no-op. Kept here too so equity still updates even if the Tradesea
      // watcher's own poll cycle is unusually slow relative to price ticks.
      await this.recordTradeseaEquitySnapshot();
    }

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

  // Records Tradesea's own equity-curve point. Deliberately NOT gated on a
  // price tick the way the primary account's equity recording above is --
  // Tradesea's own watcher never emits price ticks (see index.ts's header
  // comment on why: a second price feed would double-fire decideOnBar), so
  // tying this to onPriceTick alone meant Tradesea's balance was captured
  // live in memory every poll but never persisted to EquityCurvePoint
  // unless the PRIMARY (TopstepX) watcher also happened to be ticking --
  // confirmed live, 2026-08-28, an avoidable coupling: balance snapshotting
  // has no real dependency on price data the way stop/target monitoring
  // does. Called from two places: onPriceTick above (kept, redundant but
  // harmless -- see its own comment) and index.ts's Tradesea BrowserWatcher
  // account-snapshot callback directly, which is what actually makes this
  // independent of TopstepX's connection state. No-ops if Tradesea isn't
  // configured/connected. lastPrices is passed empty -- computeAccountEquity's
  // browser-live-snapshot branch (the one Tradesea actually uses) doesn't
  // read it at all; it only matters for the no-snapshot-yet fallback, where
  // an empty map just means open-position unrealized P&L reads as 0 until a
  // real price is known, same conservative behavior as any other transient
  // no-data moment.
  async recordTradeseaEquitySnapshot(): Promise<void> {
    if (!this.secondaryBroker || !this.secondaryBrokerKind) return;
    const tradeseaAccount = await ensureAccountForBrokerKind(this.secondaryBrokerKind);
    const tradeseaEquity = await computeAccountEquity(tradeseaAccount, new Map(), this.secondaryBrokerKind);
    const now = Date.now();
    const lastAt = lastEquityPointAt.get(tradeseaAccount.id) ?? 0;
    if (now - lastAt >= EQUITY_POINT_MIN_INTERVAL_MS) {
      lastEquityPointAt.set(tradeseaAccount.id, now);
      await recordEquityPoint(tradeseaAccount.id, tradeseaEquity, new Decimal(tradeseaAccount.startingBalance.toString()), new Date(), this.secondaryBrokerKind);
    }
    await this.emit({ type: "equity_update", accountId: tradeseaAccount.id, equity: tradeseaEquity.toString(), time: new Date().toISOString() });
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
      await this.evaluateNewSignals(account, mode, symbol, barTime, c, systemState.tradeseaLiveEnabled);
    }
  }

  // 2026-09-03 (operator report: manually-closed positions weren't
  // auto-clearing) -- previously fetched only ONE open trade per symbol via
  // findFirst, with no orderBy (so which one was arbitrary). The moment more
  // than one trade could be open on the same symbol at once (a known
  // consequence of the same-symbol duplicate-entry race, e.g. trades
  // #199/#200, both NQ), every OTHER open trade on that symbol became
  // permanently invisible to this loop -- no stop/target monitoring, no
  // isPositionFlat reconciliation, forever, until the one trade this
  // function happened to pick up eventually closed and freed findFirst to
  // notice the next one. Now fetches and manages every open trade on the
  // symbol, each independently.
  private async manageOpenTrades(account: Account, symbol: string, barTime: Date, h: Decimal, l: Decimal, c: Decimal): Promise<void> {
    const openTrades = await prisma.trade.findMany({ where: { accountId: account.id, symbol, status: "open" } });
    if (openTrades.length === 0) return;

    for (const openTrade of openTrades) {
      this.trackExcursion(openTrade, h, l);

      if (openTrade.brokerKind !== BrokerKind.SIMULATED) {
        await this.manageLiveOpenTrade(account, openTrade, symbol, barTime, h, l);
        continue;
      }

      await this.manageSimulatedOpenTrade(account, openTrade, symbol, barTime, h, l, c);
    }
  }

  // Extracted from manageOpenTrades so it can run once per open trade
  // instead of assuming there's only one. Known limitation, unchanged by
  // this fix: SimulatedBroker's own bracket/trailing-stop state
  // (updateTrailingStop/getBracketStopPrice) is a single Map keyed by
  // symbol, not by trade -- with two simulated trades open on the same
  // symbol, both read/share that one bracket rather than each having their
  // own. Lower stakes than the live case this fix targets (paper money, and
  // the underlying duplicate-entry race is the real thing to fix), so left
  // as a known gap rather than a second problem solved in the same pass.
  private async manageSimulatedOpenTrade(account: Account, openTrade: Trade, symbol: string, barTime: Date, h: Decimal, l: Decimal, c: Decimal): Promise<void> {
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
    await this.closeTrade(account, { tradeId: openTrade.id, symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: undefined });
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
    const broker = await this.brokerForTrade(openTrade);
    const brokerAccountId = (await broker.getAccounts())[0]!.accountId;
    const stopPrice = new Decimal(openTrade.stopPrice.toString());
    const takeProfitPrice = openTrade.takeProfitPrice ? new Decimal(openTrade.takeProfitPrice.toString()) : null;
    const entryPrice = new Decimal(openTrade.entryPrice.toString());
    const side = openTrade.side as "long" | "short";

    // v1.3: once price reaches TRAILING_STOP_ACTIVATION_FRACTION of the way to
    // the take-profit target (65% as of 2026-09-21), place a real
    // broker-side Trailing Stop order and stop relying on our own internal
    // stopPrice check for this trade -- see risk/stops.ts's hasReachedTrailingStopActivation/activateTrailingStop.
    //
    // Was DISABLED 2026-08-13 (operator request: "make sure live mode is
    // exactly as paper mode currently is which means we have to disable the
    // trailing stop loss for live mode") -- paper's SimulatedBroker never
    // arms a real broker-side trailing order the way live did here, so live
    // trailing this way was a real behavioral divergence from paper, not
    // just an execution-mechanics one.
    //
    // RE-ENABLED 2026-08-17 (operator request). A same-day attempt at a
    // fixed-point-distance version of "halfway" (9 points for one
    // instrument, 15 for another, replacing the fraction-based rule for
    // those two instruments specifically) was tried and then explicitly
    // reverted after the operator gave a concrete counter-example (entry 10,
    // target 6, trailing should start at 8 -- exactly entry + 0.5 x (target -
    // entry)) -- final state is every instrument on the plain
    // activation fraction below, no per-instrument branching at
    // all.
    //
    // DISABLED AGAIN 2026-08-18 (operator request: "turn off the trailing
    // function right now"). Same posture as the 2026-08-13 disable above --
    // trailingStopPlaced never becomes true for a NEW live trade, every live
    // trade protects itself with only its fixed stopPrice/takeProfitPrice,
    // and a trade that already had a real trailing order resting from before
    // this change still closes out correctly via the isFlatNow-trailing_stop
    // branch below.
    //
    // RE-ENABLED 2026-09-09 (operator instruction: "a trailing stop loss
    // with 5 ticks should be applied when an execution hits half way to the
    // target tp"), prompted by a real incident the same day: trade #299 (ES
    // short) had stopPrice 7653.25 but recorded exit_price 7654.00 -- a real
    // 3-tick slippage loss beyond the intended stop. Root cause is the same
    // one the 2026-09-04 fix below (LIVE_TAKE_PROFIT_ORDER_ENABLED) already
    // addressed for the take-profit side only: this trade's own hitStop
    // check runs off the browser price-tick stream (onPriceTick), which can
    // silently go stale (the CDP tab periodically drops/re-authenticates,
    // confirmed recurring live tonight) -- while stale, hitStop never fires
    // at all, and by the time it recovers, price has already run past the
    // stop. A real broker-side Trailing Stop order, once armed, is enforced
    // server-side and is immune to our own feed going stale, same protection
    // the take-profit order already gets. Distance is per-instrument and
    // ATR-scaled where a band is configured (risk/stops.ts's
    // resolveTrailingStopDistanceTicks); instruments without a band keep the
    // flat TRAILING_STOP_DISTANCE_TICKS -- see those for the history.
    const LIVE_TRAILING_STOP_ENABLED = true;
    let trailingStopPlaced = openTrade.trailingStopPlaced;
    if (LIVE_TRAILING_STOP_ENABLED && !trailingStopPlaced && takeProfitPrice !== null && hasReachedTrailingStopActivation(entryPrice, takeProfitPrice, side, h, l)) {
      trailingStopPlaced = await this.activateTrailingStop(openTrade, symbol);
    }

    // 2026-09-04 (operator report: a position's own recorded price data showed it crossing
    // takeProfitPrice more than once while still open -- root cause was the browser price feed
    // going stale, which silently stops this very function's own hitTarget check along with it,
    // since both run off the same price-tick stream via onPriceTick). Unlike the trailing stop
    // above, this isn't gated on reaching any price level first -- attempted immediately (retried
    // every tick until it succeeds) so the target gets real broker-side enforcement from as close
    // to entry as possible, independent of our own feed's health. One-line disable (flip to false)
    // if ever needed, same posture as LIVE_TRAILING_STOP_ENABLED.
    const LIVE_TAKE_PROFIT_ORDER_ENABLED = true;
    let takeProfitOrderPlaced = openTrade.takeProfitOrderPlaced;
    if (LIVE_TAKE_PROFIT_ORDER_ENABLED && !takeProfitOrderPlaced && !openTrade.letItRide && takeProfitPrice !== null) {
      takeProfitOrderPlaced = await this.activateTakeProfitOrder(openTrade, symbol, takeProfitPrice);
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
        // exitReason "trailing_stop", not "stop" -- see explain/engine.ts's
        // explainTradeExit (2026-08-12 fix): a real trailing stop only ever
        // arms after price has already reached most of the way to the take-profit
        // target, so it typically LOCKS IN a favorable move, not a loss --
        // "the stop-loss was hit" read as a loss event even for genuinely
        // profitable trailing-stop exits (confirmed live, e.g. trade #344:
        // "gain of 45.00 -- the stop-loss was hit"), which is exactly
        // backwards. explainTradeExit already had the correct
        // "trailing_stop" message ("...locking in a favorable move") but
        // this call site had never actually used it.
        await this.closeTrade(account, { tradeId: openTrade.id, symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason: "trailing_stop", customTag: "estimated_from_trailing_stop" }, broker);
        logger.info({ symbol, tradeId: openTrade.id }, "live_trade_closed_via_trailing_stop");
      } else if (takeProfitOrderPlaced && takeProfitPrice !== null) {
        // A real take-profit LIMIT order was genuinely resting -- a limit order fills at its
        // stated price or better, so takeProfitPrice itself is a tighter estimate than the
        // trailing stop's "adverse extreme" guess above (still labeled an estimate, not a
        // confirmed fill, since this app has no way yet to read back the actual fill price for
        // this order type -- see readRealFillPrice's own comment on entry fills for the same gap).
        await this.closeTrade(account, { tradeId: openTrade.id, symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice: takeProfitPrice, exitReason: "target", customTag: "estimated_from_take_profit_order" }, broker);
        logger.info({ symbol, tradeId: openTrade.id }, "live_trade_closed_via_take_profit_order");
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
    // trailing stop, or a manual close) can end the trade. Once a real
    // take-profit order is resting (takeProfitOrderPlaced), IT -- not this
    // in-process check -- is what closes the trade; a broker-driven fill is
    // caught by the isPositionFlat check above instead, same reasoning as
    // hitStop deferring to trailingStopPlaced below.
    const hitTarget = !openTrade.letItRide && !takeProfitOrderPlaced && takeProfitPrice !== null && (side === "long" ? h.gte(takeProfitPrice) : l.lte(takeProfitPrice));
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
      await this.closeTrade(account, { tradeId: openTrade.id, symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: "estimated_from_bracket" }, broker);
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
        await this.closeTrade(account, { tradeId: openTrade.id, symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: "estimated_from_bracket" }, broker);
        return;
      }
      logger.warn({ symbol, tradeId: openTrade.id, error: closeResult?.error }, "close_position_failed_falling_back_to_flatten");
      closeResult = await broker.flattenPosition?.(symbol, openTrade.side as "long" | "short", openTrade.quantity);
      closeTag = "forced_close_via_opposite_order";
    }

    if (closeResult && closeResult.status !== "rejected") {
      await this.closeTrade(account, { tradeId: openTrade.id, symbol, accountId: brokerAccountId, exitTime: barTime, exitPrice, exitReason, customTag: closeTag }, broker);
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
    const broker = await this.brokerForTrade(openTrade);
    if (!broker.placeTrailingStop) {
      logger.warn({ symbol, tradeId: openTrade.id }, "trailing_stop_not_supported_by_broker");
      return false;
    }

    // 2026-09-21: per-instrument, ATR-scaled where a band is configured --
    // see risk/stops.ts's resolveTrailingStopDistanceTicks. ATR is read here
    // rather than threaded down through manageOpenTrades/manageLiveOpenTrade
    // (neither of which has bars in scope) because this runs once per trade,
    // at the single moment the trail arms, not per tick -- so one bar query
    // costs nothing measurable, and the distance reflects the tape as it is
    // when the order is actually placed rather than as it was at entry.
    // A failed/short bar load leaves atrValue null, which the resolver
    // handles by taking the band minimum; it never throws into the
    // activation path.
    const instrument = getInstrument(symbol);
    let atrValue: Decimal | null = null;
    try {
      const bars = await loadRecentBars(symbol, 300);
      const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
      const last = atrSeries[atrSeries.length - 1];
      if (last !== undefined) atrValue = new Decimal(last);
    } catch (err) {
      logger.warn({ symbol, tradeId: openTrade.id, err: String(err) }, "trailing_stop_atr_read_failed_using_band_minimum");
    }
    const trailTicks = resolveTrailingStopDistanceTicks(instrument, atrValue);
    const result = await broker.placeTrailingStop(symbol, openTrade.side as "long" | "short", openTrade.quantity, trailTicks);
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
    logger.info({ symbol, tradeId: openTrade.id, trailTicks }, "trailing_stop_activated");
    return true;
  }

  // 2026-09-04: places the real broker-side take-profit LIMIT order that supersedes this trade's
  // internal takeProfitPrice check (see manageLiveOpenTrade above and BrokerClient.
  // placeTakeProfitOrder's own doc comment for why this exists). Returns false (and leaves
  // takeProfitOrderPlaced unset) on any failure -- the caller retries on the next tick rather than
  // silently leaving the target unprotected, same shape as activateTrailingStop above.
  private async activateTakeProfitOrder(openTrade: Trade, symbol: string, takeProfitPrice: Decimal): Promise<boolean> {
    const broker = await this.brokerForTrade(openTrade);
    if (!broker.placeTakeProfitOrder) {
      logger.warn({ symbol, tradeId: openTrade.id }, "take_profit_order_not_supported_by_broker");
      return false;
    }

    const result = await broker.placeTakeProfitOrder(symbol, openTrade.side as "long" | "short", openTrade.quantity, takeProfitPrice);
    if (result.status === "rejected") {
      logger.warn({ symbol, tradeId: openTrade.id, error: result.error }, "take_profit_order_activation_failed");
      return false;
    }

    await prisma.trade.update({ where: { id: openTrade.id }, data: { takeProfitOrderPlaced: true } });
    await prisma.orderRecord.create({
      data: {
        tradeId: openTrade.id,
        brokerOrderId: result.brokerOrderId,
        accountId: openTrade.accountId,
        symbol,
        orderType: "take_profit_limit",
        side: openTrade.side === "long" ? "sell" : "buy",
        price: takeProfitPrice.toString(),
        quantity: openTrade.quantity,
        status: "pending",
      },
    });
    logger.info({ symbol, tradeId: openTrade.id, takeProfitPrice: takeProfitPrice.toString() }, "take_profit_order_activated");
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

  // v1.5 (2026-08-31, operator report of a closed trade recording the wrong
  // entry/exit/pnl): neither price this app records for a live
  // BrowserControlBroker trade was ever guaranteed real -- exit was always
  // this app's own pre-computed stop/target estimate (see closeTrade's
  // tagNote below), and entry itself could silently fall back to the
  // pre-trade theoretical price whenever positionsPanel.ts's real-fill read
  // failed (confirmed live the same day: a genuine trade's stored entry was
  // 12.5 points off its real fill for exactly this reason). Shared by
  // closeTrade and reconcileBrokerFlatTrade below -- both want the same real
  // data, matched the same way. Returns null (never guesses) when the
  // broker doesn't support this, the panel can't be read, or nothing in it
  // plausibly matches -- see tradeHistoryPanel.ts's findMatchingClosedTrade
  // for the match rule (side + quantity + closest entryTime, never price).
  private async tryReadRealClosedTrade(trade: Trade): Promise<ClosedTradeHistoryEntry | null> {
    const broker = await this.brokerForTrade(trade);
    if (!broker.readClosedTradeHistory) return null;
    const entries = await broker.readClosedTradeHistory(trade.symbol).catch(() => null);
    if (!entries) return null;

    // Never let two of our own trades claim the same real broker fill -- see
    // findMatchingClosedTrade's own comment for the concrete incident
    // (trades #234/#236, both matched to brokerOrderId "3063210748",
    // double-attributing one real -$18.60 loss to two different Trade rows)
    // this prevents. The known TOCTOU duplicate-entry race (manageOpenTrades'
    // own comment) is exactly what makes this collision easy to hit: two
    // same-side, same-quantity trades entered minutes apart, both within
    // findMatchingClosedTrade's MATCH_TOLERANCE_MS of the one real fill.
    const alreadyClaimed = await prisma.trade.findMany({
      where: { symbol: trade.symbol, id: { not: trade.id }, brokerOrderId: { not: null } },
      select: { brokerOrderId: true },
    });
    const excludeBrokerTradeIds = new Set(alreadyClaimed.map((t) => t.brokerOrderId!));

    return findMatchingClosedTrade({ side: trade.side, quantity: trade.quantity, entryTime: trade.entryTime }, entries, excludeBrokerTradeIds);
  }

  // Automates the clear-pos skill for the one case closeTrade can't cover:
  // a trade with no real protective order ever resting (trailingStopPlaced
  // false), where the broker now reports flat but our own price levels
  // never crossed. Two indistinguishable real causes -- a phantom trade
  // that was never actually filled (see execution/engine.ts's known fill-
  // verification gap), or a real position closed entirely out-of-band (the
  // operator closing it directly, a lockout, anything broker-side) -- and
  // neither used to have a reliable exit price or pnl to report, so both
  // were left null rather than fabricated. v1.5: now tries the real broker
  // history first (see tryReadRealClosedTrade above) -- most "no protective
  // order resting" trades are actually the phantom-vs-out-of-band ambiguity
  // this comment describes, but a genuine real trade can also reach this
  // path (e.g. trailingStopPlaced never got set for an otherwise-real
  // fill), and when the real history confirms one, there's no reason left
  // to report null. Only falls through to the original null-everything
  // behavior when no real match is found.
  private async reconcileBrokerFlatTrade(trade: Trade): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const real = await this.tryReadRealClosedTrade(trade);

    if (real) {
      const explanation = explainTradeExit(trade.symbol, trade.side, "auto_reconciled", real.exitPrice, real.netPnl);
      // Correcting entryPrice without moving the bracket with it left the
      // stored risk and reward disagreeing with the distances the risk engine
      // actually sized -- see risk/stops.ts's reanchorBracketToRealEntry.
      const reanchored = reanchorBracketToRealEntry(
        new Decimal(trade.entryPrice.toString()),
        real.entryPrice,
        new Decimal(trade.stopPrice.toString()),
        trade.takeProfitPrice ? new Decimal(trade.takeProfitPrice.toString()) : null
      );
      if (!reanchored.offset.isZero()) {
        logger.info(
          {
            symbol: trade.symbol,
            tradeId: trade.id,
            recordedEntry: trade.entryPrice.toString(),
            realEntry: real.entryPrice.toString(),
            offset: reanchored.offset.toString(),
            stopPrice: reanchored.stopPrice.toString(),
            takeProfitPrice: reanchored.takeProfitPrice?.toString() ?? null,
          },
          "bracket_reanchored_to_real_entry"
        );
      }
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          entryPrice: real.entryPrice.toString(),
          stopPrice: reanchored.stopPrice.toString(),
          takeProfitPrice: reanchored.takeProfitPrice?.toString() ?? null,
          exitTime: real.exitTime,
          exitPrice: real.exitPrice.toString(),
          exitReason: "auto_reconciled",
          pnl: real.netPnl.toString(),
          fees: real.totalDeductions.negated().toString(),
          brokerOrderId: real.brokerTradeId,
          status: "closed",
          explanation:
            `${trade.explanation} ${explanation} [AUTO-RECONCILED ${today}: TopstepX confirmed no open position for ` +
            `this symbol; entry/exit/pnl read from its own Trade History (order ${real.brokerTradeId}) -- a real ` +
            `confirmed fill, not an estimate.]`,
        },
      });
      logger.info({ symbol: trade.symbol, tradeId: trade.id, brokerTradeId: real.brokerTradeId }, "trade_auto_reconciled_from_broker_history");
      await this.emit({ type: "trade_closed", tradeId: trade.id, symbol: trade.symbol, pnl: real.netPnl.toString(), explanation });
      return;
    }

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

  /**
   * Cancels whatever is still resting on `symbol` after a live position has
   * closed. Best-effort: logs and moves on, never throws into the close path.
   *
   * 2026-09-20 (operator request, after asking directly whether closing a
   * trade cancels resting orders -- it did not). TopstepX's own bracket is
   * normally OCO, so a stop fill cancels its paired target server-side. What
   * that pairing does NOT cover is activateTakeProfitOrder's standalone
   * take-profit LIMIT (tracked by Trade.takeProfitOrderPlaced): if the
   * position then exits any other way -- stop, real trailing stop, manual or
   * assistant close, or manageLiveOpenTrade's forced close -- that limit is
   * still working against a now-flat account, and filling it OPENS a new
   * untracked position on the opposite side with no stop and no Trade row
   * behind it. That's the mirror image of the 2026-07-19 phantom-position
   * incident (DB said open, broker was flat); this one is DB closed, broker
   * still working. api/routes/positions.ts's letItRide path already cancels
   * for exactly this reason -- "a real resting order doesn't know about that
   * flag at all" -- it just wasn't wired into the ordinary close path.
   *
   * Two guards, both deliberate, both for reasons this file already has scar
   * tissue about:
   *  - Only fires on a CONFIRMED-flat readback. `isPositionFlat` returning
   *    null means "couldn't read it", and cancelling the bracket of a
   *    still-open position would strip its stop -- so null is treated as
   *    "don't touch it", the same don't-act-on-an-assumption posture
   *    manageLiveOpenTrade's own flatten path documents.
   *  - Skips if any other trade on this symbol is still open, since
   *    "Cancel Orders" is symbol-scoped, not per-order (see
   *    browserControl/orderTicket.ts's cancelOrdersButton) and would take
   *    that trade's protection with it.
   */
  private async cancelRestingOrdersAfterClose(broker: BrokerClient, tradeId: number, symbol: string, accountId: number): Promise<void> {
    if (!broker.cancelRestingOrder || !broker.isPositionFlat) return;
    try {
      const stillOpenElsewhere = await prisma.trade.findFirst({ where: { accountId, symbol, status: "open" } });
      if (stillOpenElsewhere) {
        logger.info({ symbol, tradeId, otherTradeId: stillOpenElsewhere.id }, "skipping_resting_order_cancel_other_trade_still_open");
        return;
      }

      const isFlat = await broker.isPositionFlat(symbol);
      if (isFlat !== true) {
        logger.warn({ symbol, tradeId, isFlat }, "skipping_resting_order_cancel_position_not_confirmed_flat");
        return;
      }

      const result = await broker.cancelRestingOrder(symbol);
      if (result.status === "rejected") {
        logger.warn({ symbol, tradeId, error: result.error }, "cancel_resting_orders_after_close_rejected");
      } else {
        logger.info({ symbol, tradeId }, "cancel_resting_orders_after_close_ok");
      }
    } catch (err) {
      logger.warn({ symbol, tradeId, err: String(err) }, "cancel_resting_orders_after_close_failed");
    }
  }

  private async closeTrade(account: Account, closed: ClosedSimTrade, liveBroker?: BrokerClient): Promise<void> {
    // Looked up by the specific tradeId the caller already has in hand, not
    // re-derived by (account, symbol) -- see ClosedSimTrade.tradeId's own
    // comment for the bug this fixes. Still guards status === "open" so a
    // double-close (e.g. two overlapping ticks racing to close the same
    // trade) is a safe no-op, not a second write over an already-closed row.
    const trade = await prisma.trade.findFirst({ where: { id: closed.tradeId, accountId: account.id, status: "open" } });
    if (!trade) return;

    const excursion = tradeExcursion.get(trade.id) ?? { mfe: new Decimal(0), mae: new Decimal(0) };
    tradeExcursion.delete(trade.id);

    const real = await this.tryReadRealClosedTrade(trade);
    if (real) {
      const explanation = explainTradeExit(trade.symbol, trade.side, closed.exitReason, real.exitPrice, real.netPnl);
      const tagNote = ` [entry/exit/pnl corrected from TopstepX's own Trade History (order ${real.brokerTradeId}) -- a real confirmed fill, not this app's estimate]`;
      // Same re-anchor as reconcileBrokerFlatTrade above -- both correct
      // entryPrice from real broker history, so both must move the bracket by
      // the same offset or the stored risk:reward stops describing the trade
      // that actually ran. See risk/stops.ts's reanchorBracketToRealEntry.
      const reanchored = reanchorBracketToRealEntry(
        new Decimal(trade.entryPrice.toString()),
        real.entryPrice,
        new Decimal(trade.stopPrice.toString()),
        trade.takeProfitPrice ? new Decimal(trade.takeProfitPrice.toString()) : null
      );
      if (!reanchored.offset.isZero()) {
        logger.info(
          {
            symbol: trade.symbol,
            tradeId: trade.id,
            recordedEntry: trade.entryPrice.toString(),
            realEntry: real.entryPrice.toString(),
            offset: reanchored.offset.toString(),
            stopPrice: reanchored.stopPrice.toString(),
            takeProfitPrice: reanchored.takeProfitPrice?.toString() ?? null,
          },
          "bracket_reanchored_to_real_entry"
        );
      }
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          entryPrice: real.entryPrice.toString(),
          stopPrice: reanchored.stopPrice.toString(),
          takeProfitPrice: reanchored.takeProfitPrice?.toString() ?? null,
          exitTime: real.exitTime,
          exitPrice: real.exitPrice.toString(),
          exitReason: closed.exitReason,
          pnl: real.netPnl.toString(),
          fees: real.totalDeductions.negated().toString(),
          brokerOrderId: real.brokerTradeId,
          mae: excursion.mae.toString(),
          mfe: excursion.mfe.toString(),
          status: "closed",
          explanation: `${trade.explanation} ${explanation}${tagNote}`,
        },
      });
      await this.emit({ type: "trade_closed", tradeId: trade.id, symbol: trade.symbol, pnl: real.netPnl.toString(), explanation });
      if (liveBroker) await this.cancelRestingOrdersAfterClose(liveBroker, trade.id, trade.symbol, account.id);
      return;
    }

    const instrument = getInstrument(trade.symbol);
    const direction = trade.side === "long" ? 1 : -1;
    const pnl = closed.exitPrice.minus(trade.entryPrice.toString()).times(direction).times(instrument.pointValue).times(trade.quantity);

    const explanation = explainTradeExit(trade.symbol, trade.side, closed.exitReason, closed.exitPrice, pnl);
    // customTag on a live-broker close (see manageLiveOpenTrade) marks the
    // exit price/pnl as an estimate from our own configured stop/target, not
    // a confirmed broker fill -- surfaced here so it's never silently
    // presented as precise financial data. Only reached when
    // tryReadRealClosedTrade above found no real match (broker doesn't
    // support it, e.g. SimulatedBroker, or nothing plausible in the panel).
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
    if (liveBroker) await this.cancelRestingOrdersAfterClose(liveBroker, trade.id, trade.symbol, account.id);
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
          contextBucket: computeContextBucket(features.session, features.trendLabel as "up" | "down" | "none", features.volLabel as "high" | "normal" | "low"),
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

  // SHADOW ONLY (2026-09-03, operator request) -- computes what
  // scoring/sessionSwitchingAgent.ts's session-best-version selection would
  // pick, and whether that version's OWN decision agrees with taking this
  // exact signal, purely to log it for later review. Never reads back into
  // `consensus`/`assessment`/execution -- see that file's header comment for
  // why this hasn't been promoted to an actual gate yet (backtested net
  // negative under both a naive and a margin-refined selection rule).
  // Errors are swallowed (warn-logged, not rethrown) since a shadow feature
  // must never be able to break real trading.
  private async logSessionSwitchingShadow(symbol: string, side: "long" | "short", strategyId: string, barTime: Date, gatedByVersion: Map<StrategyVersion, GatedScore>): Promise<void> {
    try {
      const session = classifySession(barTime);
      const selection = await getSessionSwitchingSelection(session, barTime);
      if (selection.selectedVersion === null) return; // cold-start or no statistical margin -- nothing actionable to log yet
      const wouldTake = gatedByVersion.get(selection.selectedVersion)?.decision === "taken";
      logger.info(
        { symbol, side, strategyId, session, selectedVersion: selection.selectedVersion, wouldTake, reason: selection.reason },
        "session_switching_agent_shadow_decision"
      );
    } catch (err) {
      logger.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, "session_switching_agent_shadow_failed");
    }
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
    /**
     * Where the order actually rests -- analytics/smartEntry.ts's picked
     * price (2026-08-09), NOT necessarily closePrice. Kept as its own param
     * rather than read off `assessment` so this function doesn't need to
     * know decisionCore.ts's specific plan shape; callers that don't compute
     * a smart entry (there are none left, but defensively) can just pass
     * closePrice again.
     */
    entryPrice: Decimal;
    atrValue: Decimal;
    instrument: InstrumentSpec;
    regime: RegimeResult;
    bars: OhlcBar[];
    barTime: Date;
    /**
     * Executes against a SPECIFIC broker/kind instead of deriving them from
     * `mode` via brokerForMode/brokerKindForMode -- added for the Tradesea
     * integration (2026-08-27), so a second live venue can execute the same
     * decision independently of what `mode` (TopstepX's own gate) is set to.
     * `account` above must be that venue's own Account row when this is
     * used (executeIfApproved creates the Trade row under `account.id`).
     * Omitted, behavior is byte-identical to before this param existed.
     */
    brokerOverride?: BrokerClient;
    brokerKindOverride?: BrokerKind;
  }): Promise<{ outcome: "consensus_not_reached" | "risk_rejected" | "kill_switch" | "executed"; executed: boolean }> {
    const { consensus, assessment, gatedByVersion, scoreIdByVersion, account, mode, symbol, side, strategyId, structureSwingPrice, signalKind, breakoutLevelPrice, closePrice, entryPrice, atrValue, instrument, regime, bars, barTime, brokerOverride, brokerKindOverride } = params;

    // SHADOW ONLY -- fire-and-forget, must never add latency or failure risk
    // to the real execution decision below. See scoring/sessionSwitchingAgent.ts.
    void this.logSessionSwitchingShadow(symbol, side, strategyId, barTime, gatedByVersion);

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
    const broker = brokerOverride ?? this.brokerForMode(mode);
    const brokerAccountId = (await broker.getAccounts())[0]!.accountId;
    const brokerKind = brokerKindOverride ?? this.brokerKindForMode(mode);

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
      entryPrice, regime.trendLabel, regime.volLabel, decisionExplanation, barTime, decisionScoreId
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
  private async evaluateNewSignals(
    account: Account,
    mode: TradingMode,
    symbol: string,
    barTime: Date,
    closePrice: Decimal,
    tradeseaLiveEnabled = false
  ): Promise<void> {
    // 2026-09-03, operator request: "add a toggle so i can turn off which
    // markets are executable." Checked first, before anything else -- a
    // disabled symbol has nothing to evaluate at all.
    if ((await getDisabledSymbols()).has(symbol)) return;

    const bars: OhlcBar[] = await loadRecentBars(symbol, 300);
    if (bars.length < MIN_BARS_FOR_REGIME) return;

    const regime = classifyRegime(bars);
    setLatestRegimeSnapshot(symbol, {
      time: barTime, trendLabel: regime.trendLabel, volLabel: regime.volLabel,
      confidence: regime.confidence.toString(), features: JSON.parse(JSON.stringify(regime.features)),
    });
    await this.emit({ type: "regime", symbol, trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence });

    // Tradesea executes the SAME decision as the primary venue, so it's only
    // even attempted when its own independent gate is fully cleared --
    // TRADESEA_ENABLED, TRADESEA_LIVE_TRADING_CONFIRMED, and the runtime
    // tradeseaLiveEnabled switch (see execution/mode.ts's
    // setTradeseaLiveEnabled) -- never TopstepX's own TRADING_MODE/mode.
    const tradeseaActive = tradeseaLiveEnabled && this.secondaryBroker !== null && this.secondaryBrokerKind !== null;
    const tradeseaAccount = tradeseaActive ? await ensureAccountForBrokerKind(this.secondaryBrokerKind!) : null;

    // Skip generating new entries into a symbol that already has an open
    // position -- widened to check every CONNECTED live account (not just
    // the primary) so the two venues move together as a pair: neither gets
    // a new signal for this symbol until BOTH are flat (2026-08-27, operator
    // request: "they should both execute trades at the same exact time").
    const openCheckAccountIds = tradeseaAccount ? [account.id, tradeseaAccount.id] : [account.id];
    const hasOpen = await prisma.trade.findFirst({ where: { accountId: { in: openCheckAccountIds }, symbol, status: "open" }, select: { id: true } });
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

    const ctx = new LiveDecisionContext({ accountId: account.id, accountState, riskLimits, executionSettings, secondaryAccountId: tradeseaAccount?.id });
    const barDecisions = await decideOnBar({ ctx, symbol, barTime, closePrice });

    const instrument = getInstrument(symbol);

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
        // decision.plan.entryPrice is analytics/smartEntry.ts's picked price
        // (decisionCore.ts computes it before assessNewTrade so stop/target/
        // sizing are already consistent with it) -- falls back to closePrice
        // only when plan is null, which attemptExecution short-circuits on
        // before ever reading entryPrice, so the exact fallback value here
        // is inert.
        closePrice, entryPrice: decision.plan?.entryPrice ?? closePrice,
        atrValue: decision.atrValue!, instrument, regime, bars, barTime,
      });

      // Tradesea executes independently, in the SAME bar-evaluation pass, so
      // both venues act on the same signal at the same time -- reusing every
      // input decideOnBar already computed (signal, ATR, the smart-entry
      // price, consensus) except account state/risk limits, which are
      // genuinely Tradesea's own (different equity, possibly different
      // limits). Not gated on `result` above -- one venue's own daily-trade-
      // cap/risk rejection must never silently skip the other.
      if (tradeseaAccount && this.secondaryBroker && decision.plan) {
        const tradeseaEquity = await computeAccountEquity(tradeseaAccount, new Map([[symbol, closePrice]]), this.secondaryBrokerKind!);
        const tradeseaAccountState = await computeAccountRiskState(tradeseaAccount, tradeseaEquity, this.secondaryBrokerKind!);
        const tradeseaRiskLimits = await this.loadRiskLimits(tradeseaAccount.id);
        const newsStatus = await getNewsRiskStatus(barTime);
        const dailyPlanZones = await getActiveDailyPlanZones(symbol, barTime);
        const hardTakeProfitDollars = await resolveHardTakeProfitDollars(symbol, barTime);
        const assistantTakeProfitCapPoints = await getAssistantTakeProfitCapPoints(symbol, barTime);
        const hasConflictingCrossSymbolPosition = await hasConflictingCrossSymbolPositionCheck(openCheckAccountIds, symbol, decision.signal.side);

        const tradeseaAssessment = new RiskEngine().assessNewTrade({
          side: decision.signal.side,
          entryPrice: decision.plan.entryPrice,
          atrValue: decision.atrValue!,
          structureSwingPrice: decision.signal.structureSwingPrice,
          signalKind: decision.signal.signalKind,
          breakoutLevelPrice: decision.signal.breakoutLevelPrice,
          accountState: tradeseaAccountState,
          limits: tradeseaRiskLimits,
          pointValue: instrument.pointValue,
          tickSize: instrument.tickSize,
          newsStatus,
          bars,
          averageProbability: decision.consensus.averageProbability,
          takeProfitRMultiple: executionSettings.takeProfitRMultiple,
          confidenceTiers: executionSettings.confidenceTiers,
          explicitStopPrice: decision.signal.explicitStopPrice ?? undefined,
          explicitTakeProfitPrice: decision.signal.explicitTakeProfitPrice ?? undefined,
          srProximityGateSuspended: isSrProximityGateSuspended(barTime),
          srGateBypass: decision.consensus.representativeVersion === "v7",
          hardTakeProfitDollars,
          assistantTakeProfitCapPoints,
          dailyPlanZones,
          requiresDailyPlan: REQUIRE_DAILY_PLAN_SYMBOLS.has(symbol),
          hasConflictingCrossSymbolPosition,
        });

        await this.attemptExecution({
          consensus: decision.consensus, assessment: tradeseaAssessment,
          gatedByVersion: decision.gatedByVersion, scoreIdByVersion, account: tradeseaAccount,
          mode: TradingMode.LIVE, symbol,
          side: decision.signal.side, strategyId: decision.signal.strategyId,
          structureSwingPrice: decision.signal.structureSwingPrice, signalKind: decision.signal.signalKind,
          breakoutLevelPrice: decision.signal.breakoutLevelPrice,
          closePrice, entryPrice: decision.plan.entryPrice,
          atrValue: decision.atrValue!, instrument, regime, bars, barTime,
          brokerOverride: this.secondaryBroker, brokerKindOverride: this.secondaryBrokerKind!,
        });
      }

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
      ACTIVE_INSTRUMENTS.map((spec) => this.scanSymbolContinuously(spec.symbol, account, mode, systemState.tradeseaLiveEnabled))
    );
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        logger.warn({ symbol: ACTIVE_INSTRUMENTS[i]!.symbol, err: String(result.reason) }, "continuous_scan_failed");
      }
    });
  }

  private async scanSymbolContinuously(symbol: string, account: Account, mode: TradingMode, tradeseaLiveEnabled = false): Promise<void> {
    // 2026-09-03, operator request: "add a toggle so i can turn off which
    // markets are executable." Checked first, before anything else.
    if ((await getDisabledSymbols()).has(symbol)) return;

    const barTime = new Date();

    const tradeseaActive = tradeseaLiveEnabled && this.secondaryBroker !== null && this.secondaryBrokerKind !== null;
    const tradeseaAccount = tradeseaActive ? await ensureAccountForBrokerKind(this.secondaryBrokerKind!) : null;

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
      // 2026-09-04 (operator report: a real open position crossed its take-profit level more than
      // once while the feed was stale, and stayed open) -- this timer runs on its own 15s clock
      // independent of price ticks (unlike manageLiveOpenTrade, which only runs when a tick
      // actually arrives, so it can't detect its OWN silence), making this the right place to
      // surface "an open position's stop/target monitoring has gone quiet" as a loud, distinct
      // signal rather than only the generic "no new signals" warning above. ERROR, not WARN --
      // "no new signals" is routine; "an open live position isn't being watched" isn't.
      const openLiveTradeIds = await prisma.trade.findMany({ where: { accountId: account.id, symbol, status: "open", brokerKind: { not: BrokerKind.SIMULATED } }, select: { id: true } });
      if (openLiveTradeIds.length > 0) {
        logger.error(
          { symbol, tradeIds: openLiveTradeIds.map((t) => t.id), lastBarTime: lastBar.time.toISOString(), staleForMs },
          "open_position_monitoring_stale -- price feed hasn't updated in this long while a live position is open; its stop/target is not being actively watched right now"
        );
      }
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

    // Fetched unconditionally, once per symbol per tick (2026-08-11 fix,
    // operator question "where does the report for each session get
    // generated"): originally this only ran inside the long/short
    // consensus.taken branch below, so a session with no continuous-scan
    // signal ever reaching consensus never computed dealer levels at all --
    // /api/dealer-levels stayed empty indefinitely. dealerGexCache.ts is
    // still session-scoped underneath, so this only ever pays for a real
    // CBOE fetch on the first tick of a new session; every other tick is a
    // cache hit. Used to also feed risk/engine.ts's dealer-GEX proximity
    // gate, removed 2026-08-12 (operator request: trades should execute as
    // long as they clear their normal rules, without an additional
    // GEX-distance constraint) -- the result is kept now (2026-08-28) only
    // to pass into logShadowGexSignal below, an observational log, NOT a
    // gate; nothing here changes which trades execute.
    const dealerLevelsForShadowLog = await getDealerLevels(symbol, bars, barTime);

    // Long and short are independent hypothetical reads over the same bars
    // -- scored concurrently (each writes its own Score rows, one per
    // version, distinct strategyId per side, so there's no shared mutable
    // state or write conflict between them). Execution is deliberately NOT
    // part of this Promise.all -- see below.
    const sideResults = await Promise.all(
      (["long", "short"] as const).map(async (side) => {
        const openingRangeBreakoutProbability = side === "long" ? openingRangeStats.probHighBroken : openingRangeStats.probLowBroken;
        const longTargetEdge = side === "long" ? await getFixedTargetEdge(symbol, session, "long", barTime) : null;

        const hypotheticalStopPlan = computeInitialStop(closePrice, side, atrValue, null, { tickSize: instrument.tickSize, takeProfitRMultiple: executionSettings.takeProfitRMultiple, recentBars: bars });
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
    const openCheckAccountIds = tradeseaAccount ? [account.id, tradeseaAccount.id] : [account.id];
    const disabledStrategyIds = await getDisabledStrategyIds();
    const disabledStrategySymbolPairs = await getDisabledStrategySymbolPairs();
    for (const { side, strategyId, gatedByVersion, scoreIdByVersion } of sideResults) {
      // Scoring/shadow-data collection above still runs regardless (real
      // analytical value even for a disabled strategy) -- this only stops a
      // disabled strategyId from actually executing, same shape as the
      // real-signal path's check in replay/decisionCore.ts.
      if (disabledStrategyIds.has(strategyId)) continue;
      // Finer-grained: this strategyId specifically on THIS symbol -- see
      // DecisionContext.disabledStrategySymbolPairs's own comment.
      if (disabledStrategySymbolPairs.has(strategySymbolKey(strategyId, symbol))) continue;

      // Widened to check every connected live account (not just the
      // primary) -- same shared-symbol-gate reasoning as
      // evaluateNewSignals's real-signal path (2026-08-27, operator
      // request: "they should both execute trades at the same exact time").
      const hasOpen = await prisma.trade.findFirst({ where: { accountId: { in: openCheckAccountIds }, symbol, status: "open" }, select: { id: true } });
      if (hasOpen) break;

      // Continuous-scan trades have no detected chart pattern, so
      // signalKind is generic "reversal" (the risk engine's "enter near a
      // real S/R level in the trade's favor" gate, not the breakout-specific
      // broken-level check) and structureSwingPrice/breakoutLevelPrice are
      // both null -- the stop plan falls back to pure ATR, same as this
      // path's hypothetical preview always has.
      const sessionSelection = await getSessionPerformanceSelection(barTime);
      const consensus = determineContinuousScanConsensus(gatedByVersion, sessionSelection, session);

      // Shadow-mode observation only (2026-08-28, gamma-desk brief) -- logs
      // the GEX regime/levels active alongside the real consensus outcome so
      // a real live sample accumulates before proposing any GEX-based gate
      // or scoring change. Never awaited-into the trading path's control
      // flow beyond this one statement, and logShadowGexSignal itself never
      // throws -- see engine/shadowGexSignalLogger.ts.
      await logShadowGexSignal({
        at: barTime, symbol, session, side, strategyId,
        closePrice, dealerLevels: dealerLevelsForShadowLog, gatedByVersion,
        consensusTaken: consensus.taken, consensusAverageProbability: consensus.averageProbability,
      });

      // attemptExecution no longer computes its own RiskAssessment (the
      // real-signal path gets one for free from decideOnBar) -- this path
      // doesn't go through decideOnBar, so it still builds one itself,
      // exactly like attemptExecution used to inline, gated the same way:
      // only when consensus was actually reached.
      let assessment: RiskAssessment | null = null;
      // Same one-shot smart entry positioning decisionCore.ts applies to the
      // real-signal path (analytics/smartEntry.ts) -- continuous scan has no
      // structureSwingPrice of its own (null, same as the assessNewTrade call
      // below), so the smart price can only ever be bounded by the signal
      // price itself, not a structural stop reference.
      const smartEntry = computeSmartEntryPrice(bars, side, closePrice, atrValue, instrument.tickSize, null);
      let dailyPlanZones: Awaited<ReturnType<typeof getActiveDailyPlanZones>> = [];
      let hardTakeProfitDollars: number | undefined;
      let assistantTakeProfitCapPoints: Awaited<ReturnType<typeof getAssistantTakeProfitCapPoints>> = null;
      let hasConflictingCrossSymbolPosition = false;
      if (consensus.taken) {
        const equity = await computeAccountEquity(account, new Map([[symbol, closePrice]]));
        const accountState = await computeAccountRiskState(account, equity);
        const limits = await this.loadRiskLimits(account.id);
        dailyPlanZones = await getActiveDailyPlanZones(symbol, barTime);
        hardTakeProfitDollars = await resolveHardTakeProfitDollars(symbol, barTime);
        assistantTakeProfitCapPoints = await getAssistantTakeProfitCapPoints(symbol, barTime);
        hasConflictingCrossSymbolPosition = await hasConflictingCrossSymbolPositionCheck(openCheckAccountIds, symbol, side);
        assessment = this.riskEngine.assessNewTrade({
          side, entryPrice: smartEntry.entryPrice, atrValue,
          structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
          accountState, limits,
          pointValue: instrument.pointValue, tickSize: instrument.tickSize, newsStatus, bars,
          averageProbability: consensus.averageProbability,
          takeProfitRMultiple: executionSettings.takeProfitRMultiple,
          confidenceTiers: executionSettings.confidenceTiers,
          srProximityGateSuspended: isSrProximityGateSuspended(barTime),
          // 2026-08-18, operator request: this trade fired because v7
          // cleared its own solo bar (determineConsensus's representativeVersion),
          // not because another version's own gate passed -- see
          // risk/engine.ts's srGateBypass for exactly what this skips.
          srGateBypass: consensus.representativeVersion === "v7",
          // 2026-08-18, operator request: "remove stop loss constraints
          // right now set a hard take profit for five dollars from entry
          // price on NQ and one dollar from entry price on ES" -- see
          // risk/engine.ts's hardTakeProfitDollars param for exactly what
          // this replaces. undefined (the pipeline's normal behavior) for
          // any symbol not in HARD_TAKE_PROFIT_DOLLARS/the daily-plan
          // take-profit target -- see dailyPlanTakeProfitCache.ts's
          // resolveHardTakeProfitDollars for the 2026-08-31 dynamic version.
          hardTakeProfitDollars,
          assistantTakeProfitCapPoints,
          dailyPlanZones,
          requiresDailyPlan: REQUIRE_DAILY_PLAN_SYMBOLS.has(symbol),
          hasConflictingCrossSymbolPosition,
        });
      }

      const result = await this.attemptExecution({
        consensus, assessment, gatedByVersion, scoreIdByVersion, account, mode, symbol, side, strategyId,
        structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
        closePrice, entryPrice: smartEntry.entryPrice, atrValue, instrument, regime, bars, barTime,
      });

      // Tradesea executes the same continuous-scan decision independently,
      // with its own account state/risk limits -- same pattern as
      // evaluateNewSignals's real-signal path. Reuses every input already
      // computed above (smartEntry, bars, newsStatus, executionSettings)
      // except account state/limits, which are genuinely Tradesea's own.
      // Not gated on `result` above -- one venue's own rejection must never
      // silently skip the other.
      if (tradeseaAccount && this.secondaryBroker && assessment) {
        const tradeseaEquity = await computeAccountEquity(tradeseaAccount, new Map([[symbol, closePrice]]), this.secondaryBrokerKind!);
        const tradeseaAccountState = await computeAccountRiskState(tradeseaAccount, tradeseaEquity, this.secondaryBrokerKind!);
        const tradeseaLimits = await this.loadRiskLimits(tradeseaAccount.id);

        const tradeseaAssessment = this.riskEngine.assessNewTrade({
          side, entryPrice: smartEntry.entryPrice, atrValue,
          structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
          accountState: tradeseaAccountState, limits: tradeseaLimits,
          pointValue: instrument.pointValue, tickSize: instrument.tickSize, newsStatus, bars,
          averageProbability: consensus.averageProbability,
          takeProfitRMultiple: executionSettings.takeProfitRMultiple,
          confidenceTiers: executionSettings.confidenceTiers,
          srProximityGateSuspended: isSrProximityGateSuspended(barTime),
          srGateBypass: consensus.representativeVersion === "v7",
          hardTakeProfitDollars,
          assistantTakeProfitCapPoints,
          dailyPlanZones,
          requiresDailyPlan: REQUIRE_DAILY_PLAN_SYMBOLS.has(symbol),
          hasConflictingCrossSymbolPosition,
        });

        await this.attemptExecution({
          consensus, assessment: tradeseaAssessment, gatedByVersion, scoreIdByVersion,
          account: tradeseaAccount, mode: TradingMode.LIVE, symbol, side, strategyId,
          structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
          closePrice, entryPrice: smartEntry.entryPrice, atrValue, instrument, regime, bars, barTime,
          brokerOverride: this.secondaryBroker, brokerKindOverride: this.secondaryBrokerKind!,
        });
      }

      if (result.outcome === "kill_switch") return;
    }
  }
}
