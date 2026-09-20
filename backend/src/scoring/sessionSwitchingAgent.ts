/**
 * SHADOW-ONLY session-switching agent (2026-09-03, operator request): for
 * each trading session independently, tracks CUMULATIVE (never reset at a
 * session boundary, unlike sessionPerformance.ts's selectSessionBestVersion)
 * taken+resolved samples per version, and only ever treats a version as
 * "the session's best" once it's both cleared a real sample floor and is
 * statistically separated from its closest competitor.
 *
 * Nothing in this file is wired into determineConsensus or
 * attemptExecution's actual execution decision -- engine/loop.ts calls this
 * purely to log what the agent WOULD have selected/decided, alongside the
 * real decision, so a live track record can accumulate before ever
 * considering promotion to an actual gate. Same posture as v5's
 * SHADOW_ONLY_VERSIONS.
 *
 * Why NOT built as a live gate yet: a walk-forward backtest
 * (backend/scripts/_simulateSessionSwitchingAgent.ts) replaying the last 225
 * real trades against a naive "switch to whichever version has the highest
 * taken-only win rate once it clears 100 samples" rule came back net
 * negative (-$952 against the real +$1390), concentrated in New York, where
 * v1 was the lone eligible candidate for a long stretch and turned out to
 * have the WORST taken-win-rate of NY's eventually-eligible versions (15.8%
 * vs v7's 28.8%) -- a lone candidate has nothing to be judged against. The
 * margin refinement below (MIN_ELIGIBLE_CANDIDATES + non-overlapping ~1 SE
 * bands) exists specifically to rule that out, but re-running the same
 * backtest with the refinement STILL came back net negative (-$2030),
 * just with the sessions that helped/hurt swapped around. Neither result is
 * strong evidence either way at n=225 over 16 days -- see
 * .claude/rules/replay-harness.md: "nine days of ES will overfit anything."
 * Shadow mode exists to accumulate a real track record before trusting this
 * with an actual gate.
 *
 * Uses the same v1/v2/v3/v6/v7 pool as CONSENSUS_BANDIT_ARMS /
 * SESSION_PERFORMANCE_ARMS -- v5 stays excluded pending its own
 * harness-validated promotion (see sessionPerformance.ts's own comment).
 */
import { prisma } from "../db/client.js";
import type { StrategyVersion } from "./ruleScorer.js";
import { CONSENSUS_BANDIT_ARMS } from "./consensusBandit.js";
import { POSITIVE_OUTCOME_LABELS, RESOLVED_OUTCOME_LABELS } from "./v3HistoricalAdjustment.js";
import type { TradingSession } from "../analytics/session.js";

export const SESSION_SWITCHING_ARMS: StrategyVersion[] = CONSENSUS_BANDIT_ARMS;

/**
 * Never treat a lone eligible candidate as "the session's best" -- it has no
 * competitor to be judged against, which is exactly the New York failure
 * mode the backtest surfaced (see this file's header comment).
 */
export const MIN_ELIGIBLE_CANDIDATES = 2;

/**
 * Cumulative taken+resolved samples required before a version's win rate is
 * even considered -- hand-set per the operator's "100 plus trades taken and
 * resolved" instruction. Cumulative across all history for that session
 * type, NOT reset at a session boundary the way sessionPerformance.ts's
 * MIN_SESSION_SAMPLES_PER_VERSION=3 is -- 100 taken+resolved trades within
 * one intraday session essentially never happens at current trade volume.
 */
export const MIN_TAKEN_RESOLVED_SAMPLES = 100;

export interface SwitchingVersionStats {
  version: StrategyVersion;
  takenResolved: number;
  /** 0 when takenResolved is 0 -- callers must gate on takenResolved, not treat a 0 win rate as "performed badly." */
  takenWinRate: number;
  /** Standard error of takenWinRate under a binomial approximation: sqrt(p(1-p)/n). 0 when takenResolved is 0. */
  standardError: number;
}

export interface SessionSwitchingSelection {
  session: TradingSession;
  /** null means: no confident pick -- caller should fall back to the real consensus rule (this is a SHADOW selection either way; nothing reads this to gate execution yet). */
  selectedVersion: StrategyVersion | null;
  reason: "selected" | "cold_start" | "no_statistical_margin";
  statsByVersion: Map<StrategyVersion, SwitchingVersionStats>;
}

function standardError(wins: number, n: number): number {
  const p = wins / n;
  return Math.sqrt((p * (1 - p)) / n);
}

/**
 * Pure -- no DB access. Requires at least MIN_ELIGIBLE_CANDIDATES eligible
 * versions (>= MIN_TAKEN_RESOLVED_SAMPLES each) AND the leader's
 * (winRate - 1 SE) to exceed the runner-up's (winRate + 1 SE) -- i.e.
 * non-overlapping ~68% confidence bands -- before ever selecting away from
 * the "no confident pick" fallback.
 */
export function selectSwitchingVersion(session: TradingSession, statsByVersion: Map<StrategyVersion, SwitchingVersionStats>): SessionSwitchingSelection {
  const eligible = [...statsByVersion.values()].filter((s) => s.takenResolved >= MIN_TAKEN_RESOLVED_SAMPLES);

  if (eligible.length < MIN_ELIGIBLE_CANDIDATES) {
    return { session, selectedVersion: null, reason: "cold_start", statsByVersion };
  }

  const sorted = [...eligible].sort((a, b) => b.takenWinRate - a.takenWinRate);
  const leader = sorted[0]!;
  const runnerUp = sorted[1]!;
  const marginClears = leader.takenWinRate - leader.standardError > runnerUp.takenWinRate + runnerUp.standardError;

  if (!marginClears) {
    return { session, selectedVersion: null, reason: "no_statistical_margin", statsByVersion };
  }

  return { session, selectedVersion: leader.version, reason: "selected", statsByVersion };
}

/**
 * Same look-ahead-safe `time: { lt: at }` bound as
 * sessionPerformance.ts's computeSessionVersionStats and
 * v3HistoricalAdjustment.ts -- live always calls with (effectively) the
 * current time, so the bound is a no-op there; see
 * .claude/rules/replay-harness.md. Restricted to decision === "taken" rows
 * (unlike sessionPerformance.ts's blended metric) -- see
 * api/routes/analytics.ts's summarizeSessionScores for why the blended
 * all-setups win rate can't actually distinguish version quality.
 */
export async function computeSwitchingVersionStats(version: StrategyVersion, session: TradingSession, at: Date): Promise<SwitchingVersionStats> {
  const where = { strategyVersion: version, session, decision: "taken", time: { lt: at } };
  const [wins, takenResolved] = await Promise.all([
    prisma.score.count({ where: { ...where, outcomeLabel: { in: [...POSITIVE_OUTCOME_LABELS] } } }),
    prisma.score.count({ where: { ...where, outcomeLabel: { in: RESOLVED_OUTCOME_LABELS } } }),
  ]);
  const takenWinRate = takenResolved > 0 ? wins / takenResolved : 0;
  return { version, takenResolved, takenWinRate, standardError: takenResolved > 0 ? standardError(wins, takenResolved) : 0 };
}

export async function computeSessionSwitchingSelection(session: TradingSession, at: Date): Promise<SessionSwitchingSelection> {
  const statsList = await Promise.all(SESSION_SWITCHING_ARMS.map((v) => computeSwitchingVersionStats(v, session, at)));
  const statsByVersion = new Map(statsList.map((s) => [s.version, s]));
  return selectSwitchingVersion(session, statsByVersion);
}
