// Lists Scout's pitches, or rates one -- how the operator does the "I review the digest and rate
// each pitch myself" step from outside a DB client.
//
// Usage (from backend/):
//   npx tsx scripts/scoutRate.ts                        list open pitches, ranked
//   npx tsx scripts/scoutRate.ts <id> <1-5> ["note"]     rate a pitch
import "../src/env.js";
import { prisma } from "../src/db/client.js";
import { computeScore } from "../src/scout/ranking.js";

async function listPitches(): Promise<void> {
  const pitches = await prisma.scoutPitch.findMany({ where: { status: "open" }, orderBy: { score: "desc" } });
  if (pitches.length === 0) {
    console.log("No open pitches yet.");
    return;
  }
  for (const p of pitches) {
    const rating = p.rating === null ? "unrated" : `${p.rating}/5`;
    console.log(`#${p.id}  [${rating}]  score=${Number(p.score).toFixed(2)}  seen=${p.occurrenceCount}x  (${p.category})`);
    console.log(`    ${p.title}`);
    console.log(`    ${p.problem}`);
    console.log("");
  }
  console.log('Rate with: npx tsx scripts/scoutRate.ts <id> <1-5> ["note"]');
}

async function ratePitch(idArg: string, ratingArg: string, note: string | undefined): Promise<void> {
  const id = Number(idArg);
  const rating = Number(ratingArg);
  if (!Number.isInteger(id)) {
    console.error(`Invalid pitch id: ${idArg}`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    console.error(`Rating must be an integer 1-5, got: ${ratingArg}`);
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.scoutPitch.findUnique({ where: { id } });
  if (!existing) {
    console.error(`No pitch #${id}.`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const score = computeScore({ occurrenceCount: existing.occurrenceCount, lastSeenAt: existing.lastSeenAt, rating }, now);
  await prisma.scoutPitch.update({
    where: { id },
    data: { rating, ratingNote: note ?? null, ratedAt: now, score: score.toFixed(4) },
  });
  console.log(`Rated pitch #${id} "${existing.title}": ${rating}/5${note ? ` -- ${note}` : ""}`);
}

async function main(): Promise<void> {
  const [idArg, ratingArg, note] = process.argv.slice(2);
  if (!idArg) {
    await listPitches();
  } else {
    await ratePitch(idArg, ratingArg, note);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
