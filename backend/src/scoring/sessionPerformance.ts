/**
 * Session-performance consensus gate (2026-08-10, operator request):
 * "automatically switch to the highest performing model based on its
 * winning score for the session, even a one-point edge -- use that version."
 * Ranks CONSENSUS_BANDIT_ARMS's same v1/v2/v3/v6/v7 pool by realized win
 * rate (Score.outcomeLabel) within the CURRENT trading session only
 * (resets at each session boundary, analytics/session.ts's getSessionStart)
 * and picks whichever version is winning right now -- no minimum margin, a
 * plain `>` comparison, per the operator's explicit instruction.
 *
 * Deliberately simpler than scoring/consensusBandit.ts's contextual UCB1
 * bandit (which buckets by session x trend x volatility and adds an
 * exploration bonus on top of mean R-multiple) -- the operator was shown
 * both options directly and chose this one: pure greedy exploitation of
 * plain session win rate, no bucketing, no exploration term. consensusBandit.ts
 * is left in place, unused by engine/loop.ts's determineConsensus as of this
 * change -- see that file's own "superseded, not deleted" convention.
 *
 * Same pure-function/DB-wrapper split as consensusBandit.ts and
 * v3HistoricalAdjustment.ts, and the same look-ahead-safe `time: { lt: at }`
 * bound -- live always calls with (effectively) the current time, so the
 * bound is a no-op there; in replay, `at` is the historical bar being
 * scored, and without it this would read outcomes from setups that (in real
 * historical time) haven't happened yet relative to that bar. See
 * .claude/rules/replay-harness.md.
 *
 * Reward signal: Score.outcomeLabel, populated for every score row
 * eventually (not just executed trades) -- engine/outcomeEvaluator.ts's
 * evaluateSkippedScores simulates a hypothetical outcome for every
 * non-executed row too, so this accumulates far faster than executed-only
 * would.
 */
import { prisma } from "../db/client.js";
import type { StrategyVersion } from "./ruleScorer.js";
import { CONSENSUS_BANDIT_ARMS } from "./consensusBandit.js";
import { POSITIVE_OUTCOME_LABELS, RESOLVED_OUTCOME_LABELS } from "./v3HistoricalAdjustment.js";

// Reuse the exact same operator-approved pool the bandit arms use, rather
// than a second, drifting list. v5 included as of 2026-09-08 -- see
// CONSENSUS_BANDIT_ARMS's own comment in consensusBandit.ts for the real
// evidence behind that promotion (v5 was excluded here, and from the bandit
// and both solo gates, before that date).
export const SESSION_PERFORMANCE_ARMS: StrategyVersion[] = CONSENSUS_BANDIT_ARMS;

// Hand-set, unproven -- same posture as every other consensus constant in
// engine/loop.ts (V6_SOLO_EXECUTION_THRESHOLD etc.): a bare floor so a
// version can't be crowned "session best" off a single lucky/unlucky score,
// not a statistically-justified sample size. The operator explicitly chose
// fast reaction ("even a one-point edge should switch immediately") over
// waiting for a large sample, so this was deliberately low -- 3, matching
// consensusBandit.ts's own MIN_PER_ARM_SAMPLES_BEFORE_BANDIT.
//
// Raised to 20 on 2026-09-23, as a direct consequence of scoping
// computeSessionVersionStats to decision: "taken" (see its own comment). While
// every row counted, every arm had thousands of samples every session and this
// floor never bound anything -- it was unreachable-low by accident, not by
// design. Counting only a version's own calls makes the counts real and much
// smaller (v5 319, v6 17 in the same session where v1 had 1371), which would
// have made a 3-sample crowning newly possible: three taken rows, three wins,
// 100% win rate, gates the session alone. That is a hazard the old metric
// structurally could not produce, so shipping the metric fix without moving
// this would have traded one broken selection for another.
//
// 20 is still a bare floor, not a statistically-justified sample size. Real
// contenders clear it easily within a session (v1 1371, v7 1190, v2 864, v3
// 1015), while a version that has barely traded -- v6's 17 -- is excluded
// rather than crowned or blamed on noise. This is the one number to lower if
// switching now feels too slow; the metric fix itself does not depend on it.
export const MIN_SESSION_SAMPLES_PER_VERSION = 20;

export interface SessionVersionStats {
  version: StrategyVersion;
  resolvedCount: number;
  /** 0 when resolvedCount is 0 -- callers must gate on resolvedCount, not treat a 0 win rate as "performed badly." */
  winRate: number;
}

export interface SessionPerformanceSelection {
  sessionStart: Date;
  /** Meaningful only when coldStart is false -- callers must fall back to the plain majority vote when coldStart is true. */
  selectedVersion: StrategyVersion;
  coldStart: boolean;
  statsByVersion: Map<StrategyVersion, SessionVersionStats>;
}

/**
 * Pure -- no DB access. Picks whichever version with >= minSamplesPerVersion
 * resolved samples this session has the highest win rate, no margin
 * required -- a strict `>` means the first-seen highest win rate wins ties,
 * and the very next resolved score that nudges another version's win rate
 * even fractionally higher flips the selection on the next call.
 */
export function selectSessionBestVersion(
  statsByVersion: Map<StrategyVersion, SessionVersionStats>,
  sessionStart: Date,
  minSamplesPerVersion: number = MIN_SESSION_SAMPLES_PER_VERSION
): SessionPerformanceSelection {
  const eligible = [...statsByVersion.values()].filter((s) => s.resolvedCount >= minSamplesPerVersion);

  if (eligible.length === 0) {
    return { sessionStart, selectedVersion: SESSION_PERFORMANCE_ARMS[0]!, coldStart: true, statsByVersion };
  }

  let best = eligible[0]!;
  for (const stats of eligible) {
    if (stats.winRate > best.winRate) best = stats;
  }

  return { sessionStart, selectedVersion: best.version, coldStart: false, statsByVersion };
}

export async function computeSessionVersionStats(version: StrategyVersion, sessionStart: Date, at: Date): Promise<SessionVersionStats> {
  // `decision: "taken"` added 2026-09-23. Without it this counted every score
  // row the version produced, INCLUDING the ones it explicitly rejected, which
  // made the metric a property of the shared signal pool rather than of the
  // version's own judgement -- every arm scores the same setups, so every arm
  // inherited nearly the same win rate. Measured live on the 2026-09-22 Asian
  // session, all rows:
  //
  //   v1 1196/4029 = 29.68%    v5 1196/4029 = 29.68%
  //   v2 1196/4029 = 29.68%    v6 1196/4029 = 29.68%
  //   v3 1198/4029 = 29.73%    v7 1202/4030 = 29.83%
  //
  // v1, v2, v5 and v6 identical to the row, and the whole field inside 0.15pp
  // -- so "pick the highest win rate" was crowning whichever version caught a
  // few lucky rows out of four thousand. Split by decision, the same session:
  //
  //   taken:   v1 31.80% (n=1371)  v2 30.79% (864)  v3 30.15% (1015)
  //            v5 31.35% (319)     v6 11.76% (17)   v7 30.00% (1190)
  //   skipped: every version 28.75%-29.90%
  //
  // v6 had taken 17 of 4049 rows, so 99.6% of its "session win rate" was the
  // base rate of setups it declined. The taken-only rates discriminate by a
  // real 1.8pp between v1 and v7, and expose v6 as genuinely bad at the few
  // calls it makes -- neither of which the old metric could see.
  //
  // This keeps the accumulation-speed property the header comment describes:
  // "taken" is the version's own judgement, NOT "executed", so a row still
  // counts when consensus or the risk engine blocked the trade, and
  // outcomeEvaluator's hypothetical simulation still fills it in. v1 reached
  // 1371 qualifying rows in a single session.
  const where = { strategyVersion: version, decision: "taken", time: { gte: sessionStart, lt: at } };
  const [wins, resolvedCount] = await Promise.all([
    prisma.score.count({ where: { ...where, outcomeLabel: { in: [...POSITIVE_OUTCOME_LABELS] } } }),
    prisma.score.count({ where: { ...where, outcomeLabel: { in: RESOLVED_OUTCOME_LABELS } } }),
  ]);
  return { version, resolvedCount, winRate: resolvedCount > 0 ? wins / resolvedCount : 0 };
}

export async function computeSessionPerformanceSelection(
  sessionStart: Date,
  at: Date,
  minSamplesPerVersion: number = MIN_SESSION_SAMPLES_PER_VERSION
): Promise<SessionPerformanceSelection> {
  const statsList = await Promise.all(SESSION_PERFORMANCE_ARMS.map((version) => computeSessionVersionStats(version, sessionStart, at)));
  const statsByVersion = new Map(statsList.map((s) => [s.version, s]));
  return selectSessionBestVersion(statsByVersion, sessionStart, minSamplesPerVersion);
}
