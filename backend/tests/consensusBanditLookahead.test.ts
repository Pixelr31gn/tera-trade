/**
 * Look-ahead safety for scoring/consensusBandit.ts's computeBucketVersionStats
 * -- .claude/rules/replay-harness.md's landmine #6. Seeds two resolved Score
 * rows in the same (strategyVersion, contextBucket): one strictly before the
 * `at` being queried, one strictly after. Only the earlier row may ever be
 * counted, or replay would silently let a bucket's bandit selection be
 * influenced by outcomes that (in real historical time) hadn't happened yet
 * relative to the bar being decided.
 *
 * Requires a reachable Postgres (TEST_DATABASE_URL or DATABASE_URL) with the
 * schema already migrated -- skips cleanly if neither is set, same convention
 * as tests/replayEquivalence.test.ts and tests/engineIntegration.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hasRealDb = !!TEST_DB_URL && !TEST_DB_URL.includes("test:test@localhost");

// Never colon-shaped like a real computeContextBucket output
// (session:trendLabel:volLabel, all from small fixed vocabularies) -- a real
// bucket string here would risk matching genuine historical rows in this
// shared dev database and silently polluting the count/mean this test
// asserts on. This value can never be produced by real code, so it's
// guaranteed collision-free regardless of what real data exists.
const SYNTHETIC_BUCKET = "__test_lookahead_bucket__";
const SYMBOL = "TESTSYM_LOOKAHEAD";
const AT = new Date("2099-03-01T12:00:00Z");
const BEFORE_AT = new Date("2099-03-01T11:00:00Z");
const AFTER_AT = new Date("2099-03-01T13:00:00Z");

describe.skipIf(!hasRealDb)("computeBucketVersionStats look-ahead safety", () => {
  let prisma: (typeof import("../src/db/client.js"))["prisma"];
  let computeBucketVersionStats: (typeof import("../src/scoring/consensusBandit.js"))["computeBucketVersionStats"];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    ({ prisma } = await import("../src/db/client.js"));
    ({ computeBucketVersionStats } = await import("../src/scoring/consensusBandit.js"));
  });

  it("counts only the row strictly before `at`, never the one after", async () => {
    try {
      await prisma.score.create({
        data: {
          time: BEFORE_AT, symbol: SYMBOL, strategyId: "test_strategy", side: "long",
          probability: "0.7", decision: "taken", features: {}, explanation: "test fixture",
          session: "new_york", entryPriceAtSignal: "100", atrAtSignal: "1",
          strategyVersion: "v1", contextBucket: SYNTHETIC_BUCKET,
          outcomeLabel: "executed_win", outcomeRMultiple: "2.0",
        },
      });
      await prisma.score.create({
        data: {
          time: AFTER_AT, symbol: SYMBOL, strategyId: "test_strategy", side: "long",
          probability: "0.7", decision: "taken", features: {}, explanation: "test fixture",
          session: "new_york", entryPriceAtSignal: "100", atrAtSignal: "1",
          strategyVersion: "v1", contextBucket: SYNTHETIC_BUCKET,
          // Deliberately a very different outcome from the "before" row --
          // if this one leaks into the stats, both plays count AND
          // meanRMultiple change, so either assertion below would fail.
          outcomeLabel: "executed_loss", outcomeRMultiple: "-1.0",
        },
      });

      const stats = await computeBucketVersionStats(SYNTHETIC_BUCKET, "v1", AT);
      expect(stats.plays).toBe(1);
      expect(stats.meanRMultiple).toBeCloseTo(2.0, 5);
    } finally {
      await prisma.score.deleteMany({ where: { symbol: SYMBOL } });
    }
  });

  it("counts neither row when `at` is before both of them", async () => {
    try {
      await prisma.score.create({
        data: {
          time: BEFORE_AT, symbol: SYMBOL, strategyId: "test_strategy", side: "long",
          probability: "0.7", decision: "taken", features: {}, explanation: "test fixture",
          session: "new_york", entryPriceAtSignal: "100", atrAtSignal: "1",
          strategyVersion: "v1", contextBucket: SYNTHETIC_BUCKET,
          outcomeLabel: "executed_win", outcomeRMultiple: "2.0",
        },
      });

      const stats = await computeBucketVersionStats(SYNTHETIC_BUCKET, "v1", new Date("2099-03-01T00:00:00Z"));
      expect(stats.plays).toBe(0);
      expect(stats.meanRMultiple).toBe(0);
    } finally {
      await prisma.score.deleteMany({ where: { symbol: SYMBOL } });
    }
  });

  it("only counts rows for the exact (strategyVersion, contextBucket) pair queried, not a different version sharing the same bucket", async () => {
    try {
      await prisma.score.create({
        data: {
          time: BEFORE_AT, symbol: SYMBOL, strategyId: "test_strategy", side: "long",
          probability: "0.7", decision: "taken", features: {}, explanation: "test fixture",
          session: "new_york", entryPriceAtSignal: "100", atrAtSignal: "1",
          strategyVersion: "v2", contextBucket: SYNTHETIC_BUCKET,
          outcomeLabel: "executed_win", outcomeRMultiple: "5.0",
        },
      });

      const stats = await computeBucketVersionStats(SYNTHETIC_BUCKET, "v1", AT);
      expect(stats.plays).toBe(0);
    } finally {
      await prisma.score.deleteMany({ where: { symbol: SYMBOL } });
    }
  });
});
