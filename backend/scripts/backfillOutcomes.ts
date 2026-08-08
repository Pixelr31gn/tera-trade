// One-off catch-up for a strategy version's outcome-label backlog, run
// outside the live 5-minute/fair-share pacing in engine/outcomeEvaluator.ts.
// That pacing exists to bound *ongoing* per-tick DB load, not because these
// rows need to wait -- most of a backlog is already old enough to have
// plenty of bars to judge against, it's just stuck behind the fair-share
// throttle. Usage: npx tsx scripts/backfillOutcomes.ts v5
import { prisma } from "../src/db/client.js";
import { evaluateSkippedScoreRow } from "../src/engine/outcomeEvaluator.js";

// Deliberately lower than outcomeEvaluator.ts's own CONCURRENCY=15 -- that
// constant is tuned for the live per-tick path, which now only handles ~40
// rows every 5 minutes per version (see the fair-share split). This script
// instead hammers continuously back-to-back with no pause, and Prisma's
// default connection pool here is only 5 (num_cpus*2+1, no explicit
// connection_limit in DATABASE_URL) -- 15 concurrent round-trips reliably
// exhausted it under sustained load (confirmed live: P2024 pool-timeout
// after ~1500-8000 rows). Stay safely under the pool size instead.
const CONCURRENCY = 4;
const FETCH_SIZE = 500;
// Transient connection drops (P1001) confirmed live against a Postgres
// container that never actually restarted (0 restarts, no gap in its own
// logs) -- almost certainly a local Docker Desktop port-forwarding blip
// under connection churn, not a real outage. Retry a few times with backoff
// instead of letting the whole run die on one flaky row.
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluateWithRetry(score: Parameters<typeof evaluateSkippedScoreRow>[0]): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await evaluateSkippedScoreRow(score);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.error(`row ${score.id} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms:`, (err as Error).message.split("\n")[0]);
      await sleep(RETRY_DELAY_MS);
    }
  }
  return false; // unreachable -- satisfies the compiler
}

async function main() {
  const strategyVersion = process.argv[2];
  if (!strategyVersion) {
    console.error("Usage: npx tsx scripts/backfillOutcomes.ts <strategyVersion>");
    process.exit(1);
  }

  let totalChecked = 0;
  let totalUpdated = 0;

  for (;;) {
    const pending = await prisma.score.findMany({
      where: { outcomeLabel: null, tradeId: null, strategyVersion },
      orderBy: { time: "asc" },
      take: FETCH_SIZE,
    });
    if (pending.length === 0) break;

    let updatedThisRound = 0;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(evaluateWithRetry));
      updatedThisRound += results.filter(Boolean).length;
    }
    totalChecked += pending.length;
    totalUpdated += updatedThisRound;
    console.log(`checked ${totalChecked} so far, updated ${totalUpdated}...`);

    // A round that updates nothing means every remaining row (oldest-first)
    // is too recent to judge yet -- stop rather than refetching forever.
    if (updatedThisRound === 0) break;
  }

  console.log(`done. checked ${totalChecked}, updated ${totalUpdated}`);
  await prisma.$disconnect();
}

main();
