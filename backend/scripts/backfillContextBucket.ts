// One-off backfill of Score.contextBucket for rows written before
// engine/loop.ts's persistScores started populating it (see
// prisma/schema.prisma's comment on the column and
// analytics/contextBucket.ts). Every existing row already has
// session/trendLabel/volLabel sitting inside its `features` JSON blob, so
// this is a pure read-modify-write with no bar-walking or broker calls --
// unlike scripts/backfillOutcomes.ts, no retry/concurrency tuning is needed
// for pool exhaustion, but the same conservative batch size is kept anyway
// since this may run alongside the live backend sharing the same pool.
// Usage: npx tsx scripts/backfillContextBucket.ts
import { prisma } from "../src/db/client.js";
import { computeContextBucket } from "../src/analytics/contextBucket.js";
import type { SetupFeatures } from "../src/scoring/features.js";

const CONCURRENCY = 4;
const FETCH_SIZE = 500;

async function main() {
  let totalChecked = 0;
  let totalUpdated = 0;
  let totalSkippedMalformed = 0;

  for (;;) {
    const pending = await prisma.score.findMany({
      where: { contextBucket: null },
      orderBy: { id: "asc" },
      take: FETCH_SIZE,
      select: { id: true, features: true },
    });
    if (pending.length === 0) break;

    let updatedThisRound = 0;
    let skippedThisRound = 0;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          const features = row.features as unknown as Partial<SetupFeatures> | null;
          if (!features?.session || !features.trendLabel || !features.volLabel) {
            // A handful of very early rows predate some of these features
            // fields entirely -- leave contextBucket null rather than
            // guessing, same posture as the other denormalized columns'
            // "only populated going forward" fallback.
            skippedThisRound++;
            return;
          }
          const contextBucket = computeContextBucket(
            features.session,
            features.trendLabel as "up" | "down" | "none",
            features.volLabel as "high" | "normal" | "low"
          );
          await prisma.score.update({ where: { id: row.id }, data: { contextBucket } });
          updatedThisRound++;
        })
      );
    }
    totalChecked += pending.length;
    totalUpdated += updatedThisRound;
    totalSkippedMalformed += skippedThisRound;
    console.log(`checked ${totalChecked} so far, updated ${totalUpdated}, skipped ${totalSkippedMalformed}...`);

    // Malformed rows never get contextBucket set, so they'd stay in the
    // WHERE set forever -- once a whole round updates nothing (every
    // remaining row this round was malformed, not a temporary condition),
    // stop instead of refetching the same rows forever.
    if (updatedThisRound === 0) break;
  }

  console.log(`done. checked ${totalChecked}, updated ${totalUpdated}, skipped (malformed) ${totalSkippedMalformed}`);
  await prisma.$disconnect();
}

main();
