/**
 * Contextual UCB1 bandit for the v1/v2/v3 leg of the live consensus gate
 * (engine/loop.ts's hasV1V2V3MajorityAgreement) -- picks which single
 * version's score gates that leg for the current market-condition bucket
 * (analytics/contextBucket.ts), based on each version's own resolved
 * Score.outcomeRMultiple history within that exact bucket, instead of a
 * fixed "2 of 3 clear 65%" rule applied identically regardless of session/
 * trend/volatility.
 *
 * Mirrors v3HistoricalAdjustment.ts's split: a pure selection function
 * (unit-testable without a DB) plus a thin DB-query wrapper around it, and
 * the same look-ahead-safe `time: { lt: at }` bound -- live always calls with
 * (effectively) the current time, so the bound is a no-op there; in replay,
 * `at` is the historical bar being scored, and without it this would read
 * outcomes from setups that (in real historical time) haven't happened yet
 * relative to that bar. See .claude/rules/replay-harness.md.
 *
 * Reward signal: Score.outcomeRMultiple, populated for every score row
 * eventually (not just executed trades) -- engine/outcomeEvaluator.ts's
 * evaluateSkippedScores simulates a hypothetical outcome for every
 * non-executed row too, so this accumulates far faster than executed-only
 * would.
 */
import { prisma } from "../db/client.js";
import type { StrategyVersion } from "./ruleScorer.js";
import { RESOLVED_OUTCOME_LABELS } from "./v3HistoricalAdjustment.js";

// Widened 2026-08-09 (operator request) from [v1,v2,v3] to include v6/v7:
// the bandit can now pick whichever of the five is the best performer for a
// given bucket, gating at LOOSE_GATE_THRESHOLD same as the others -- v6-solo
// (engine/loop.ts's hasV6SoloAgreement, 29.5%) and v7-solo (hasV7SoloAgreement,
// 65%) are untouched, separate OR'd legs alongside this one, so v6 in
// particular can still win a trade either via its own low 29.5% solo bar OR
// via being bandit-selected here at 65%, whichever fires first.
//
// Widened again 2026-09-08 (operator instruction: "v5 shadow mode=flase") to
// add v5, promoting it out of shadow-only -- unlike v6/v7's own promotions
// (both made with zero live trades behind their weight, explicitly
// evidence-free per their own comments above/in engine/loop.ts), this one has
// real evidence behind it: queried live the same day via
// /api/analytics/strategy-comparison, v5's own "taken" picks across all three
// sessions resolved to a 36.4% win rate / +0.46 avg R-multiple over 1,021
// samples -- clearly the best of any version with a real sample size (v1
// 28.2%/+0.13R n=4038, v2 28.4%/+0.14R n=2323, v3 27.8%/+0.10R n=2558, v7
// 27.1%/+0.06R n=3729). Independently confirmed via /api/analytics/version-
// divergence's stricter disagreement-only comparison (only counts setups
// where v5 and another version actually disagreed, so it isn't just riding
// the same simulated outcome as everyone else): v5's own incremental picks
// won ~36-37% head-to-head against v1/v2/v3's own incremental picks at
// ~26-27%, consistently across all three pairings. v5 stays in
// engine/loop.ts's SHADOW_ONLY_VERSIONS (that list only ever meant "excluded
// from the plain v1/v2/v3 average," not "cannot drive a trade" -- v6/v7 are
// proof, both still listed there while fully live via this same array) --
// this is the one change that actually lets it gate a real trade, via
// scoring/sessionPerformance.ts's SESSION_PERFORMANCE_ARMS (reuses this
// array verbatim) and this file's own bandit selection.
export const CONSENSUS_BANDIT_ARMS: StrategyVersion[] = ["v1", "v2", "v3", "v5", "v6", "v7"];

// Every constant below is hand-set and unproven -- same posture as
// engine/loop.ts's V6_SOLO_EXECUTION_THRESHOLD/V7_SOLO_EXECUTION_THRESHOLD:
// an explicit, informed operator call to replace the majority-vote leg live
// with zero backtested evidence behind these specific numbers (the operator
// chose this over a shadow-only validation period, matching how v6-solo/
// v7-solo were themselves promoted with zero live trades behind them). Watch
// real results; revisit via scripts/replayBanditEval.ts's walk-forward sweep.

/** Plain arithmetic-mean UCB1 applied to an unbounded R-multiple reward (not the textbook bounded-reward form). */
export const UCB_EXPLORATION_CONSTANT = 0.5;
/** Total resolved samples across all three arms combined, below which the bucket falls back to hasV1V2V3MajorityAgreement verbatim -- every bucket starts here on day one unless scripts/backfillContextBucket.ts's backfill ran. Deliberately higher than v3HistoricalAdjustment's MIN_SIMILAR_SAMPLES=5 (that one only nudges a score a few points; this one swaps the leg's entire live gating logic). */
export const MIN_BUCKET_SAMPLES_BEFORE_BANDIT = 20;
/** Refinement over textbook UCB1's optimistic-initialization: without this, an arm with literally zero history would score Infinity and could be force-picked for a real trade the first time it's ever seen in a bucket. */
export const MIN_PER_ARM_SAMPLES_BEFORE_BANDIT = 3;

export interface BucketVersionStats {
  version: StrategyVersion;
  plays: number;
  meanRMultiple: number;
}

export interface BanditSelectionResult {
  bucket: string;
  /** Meaningful only when coldStart is false -- callers must fall back to hasV1V2V3MajorityAgreement when coldStart is true. */
  selectedVersion: StrategyVersion;
  coldStart: boolean;
  armStats: Map<StrategyVersion, BucketVersionStats>;
  /** Empty when coldStart is true -- there was nothing to score arms against. */
  armScores: Map<StrategyVersion, number>;
}

/** Pure -- no DB access. UCB1: exploit (mean reward) + explore (bonus that shrinks as this arm accumulates plays, relative to the bucket's total plays). */
export function computeUcbScore(stats: BucketVersionStats, totalBucketPlays: number, explorationConstant: number): number {
  if (stats.plays <= 0) return Infinity; // optimistic initialization for an unseen arm -- normally screened out by selectBanditVersion's minPerArmSamples before this is reached in practice
  return stats.meanRMultiple + explorationConstant * Math.sqrt(Math.log(totalBucketPlays) / stats.plays);
}

/** Pure -- no DB access. `statsByVersion` must have an entry for every arm in CONSENSUS_BANDIT_ARMS. */
export function selectBanditVersion(
  statsByVersion: Map<StrategyVersion, BucketVersionStats>,
  bucket: string,
  explorationConstant: number = UCB_EXPLORATION_CONSTANT,
  minBucketSamples: number = MIN_BUCKET_SAMPLES_BEFORE_BANDIT,
  minPerArmSamples: number = MIN_PER_ARM_SAMPLES_BEFORE_BANDIT
): BanditSelectionResult {
  const allStats = [...statsByVersion.values()];
  const totalBucketPlays = allStats.reduce((sum, s) => sum + s.plays, 0);
  const coldStart = totalBucketPlays < minBucketSamples || allStats.some((s) => s.plays < minPerArmSamples);

  if (coldStart) {
    return { bucket, selectedVersion: CONSENSUS_BANDIT_ARMS[0]!, coldStart: true, armStats: statsByVersion, armScores: new Map() };
  }

  const armScores = new Map<StrategyVersion, number>();
  for (const [version, stats] of statsByVersion) {
    armScores.set(version, computeUcbScore(stats, totalBucketPlays, explorationConstant));
  }

  let selectedVersion = CONSENSUS_BANDIT_ARMS[0]!;
  let bestScore = -Infinity;
  for (const [version, score] of armScores) {
    if (score > bestScore) {
      bestScore = score;
      selectedVersion = version;
    }
  }

  return { bucket, selectedVersion, coldStart: false, armStats: statsByVersion, armScores };
}

export async function computeBucketVersionStats(bucket: string, version: StrategyVersion, at: Date): Promise<BucketVersionStats> {
  const result = await prisma.score.aggregate({
    where: { strategyVersion: version, contextBucket: bucket, outcomeLabel: { in: RESOLVED_OUTCOME_LABELS }, time: { lt: at } },
    _avg: { outcomeRMultiple: true },
    _count: { _all: true },
  });
  return {
    version,
    plays: result._count._all,
    meanRMultiple: result._avg.outcomeRMultiple ? Number(result._avg.outcomeRMultiple.toString()) : 0,
  };
}

export async function computeBanditSelection(
  bucket: string,
  at: Date,
  explorationConstant: number = UCB_EXPLORATION_CONSTANT,
  minBucketSamples: number = MIN_BUCKET_SAMPLES_BEFORE_BANDIT,
  minPerArmSamples: number = MIN_PER_ARM_SAMPLES_BEFORE_BANDIT
): Promise<BanditSelectionResult> {
  // Independent per-arm queries (unlike v1/v2/v3 scoring itself, which is
  // order-dependent because of v3's v1v2Override) -- safe to parallelize.
  const statsList = await Promise.all(CONSENSUS_BANDIT_ARMS.map((version) => computeBucketVersionStats(bucket, version, at)));
  const statsByVersion = new Map(statsList.map((s) => [s.version, s]));
  return selectBanditVersion(statsByVersion, bucket, explorationConstant, minBucketSamples, minPerArmSamples);
}
