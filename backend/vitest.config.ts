import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Loads backend/.env.test (gitignored, operator-provisioned) if present, so
// DB-backed tests like tests/replayEquivalence.test.ts and
// tests/engineIntegration.test.ts can find TEST_DATABASE_URL without it ever
// being the live backend's own operational backend/.env DATABASE_URL -- see
// that file's own header comment for why sharing the live DB would be unsafe
// (it flips the shared SystemState row's mode for the test's duration).
const testEnv = loadEnv("test", process.cwd(), "");

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Bumped 20000 -> 40000 -> 60000 (2026-08-09): decideOnBar now queries the
    // consensus bandit's per-bucket stats (scoring/consensusBandit.ts, 5 arms
    // x a DB round-trip each on a cache miss) once per distinct bucket a bar
    // lands in -- tests/engineIntegration.test.ts feeds ~80 bars through
    // onNewBar. In isolation this finishes in ~30s.
    testTimeout: 60000,
    // Default 10s hookTimeout is too tight for tests/replayEquivalence.test.ts's
    // beforeAll, which dynamically imports several heavy modules (engine/loop.ts
    // among them) and opens a real Postgres connection.
    hookTimeout: 30000,
    // Vitest's default file-level parallelism meant DB-backed test files
    // (replayEquivalence/engineIntegration/consensusBanditLookahead) competed
    // for the same real Postgres connection pool at once as every OTHER test
    // file's own client instance -- confirmed live (2026-08-09) this
    // intermittently pushed engineIntegration.test.ts past even a 60s budget
    // under a full `vitest run`, while it reliably finished in ~30s run alone.
    // Not a logic bug, purely resource contention. Sequential file execution
    // trades some total wall-clock time for eliminating that contention
    // entirely -- worth it for a production-critical trading system's test
    // suite reliability.
    fileParallelism: false,
    env: {
      // Unit tests need config.ts's zod schema to parse successfully but
      // never actually touch a database unless TEST_DATABASE_URL is set
      // (see tests/engineIntegration.test.ts).
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test",
      API_KEY: "test-key",
      TEST_DATABASE_URL: testEnv.TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "",
    },
  },
});
