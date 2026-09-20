// Lists Taylor's blueprints, or prints one in full.
//
// Usage (from backend/):
//   npx tsx scripts/taylorList.ts          list blueprints
//   npx tsx scripts/taylorList.ts <id>     print one blueprint's full content (pitch id, not blueprint id)
import "../src/env.js";
import { prisma } from "../src/db/client.js";

async function listBlueprints(): Promise<void> {
  const blueprints = await prisma.tailorBlueprint.findMany({ include: { pitch: { select: { title: true } } }, orderBy: { createdAt: "desc" } });
  if (blueprints.length === 0) {
    console.log("No blueprints yet -- Taylor only blueprints pitches rated >= TAYLOR_APPROVAL_MIN_RATING (see scripts/scoutRate.ts to rate one).");
    return;
  }
  for (const b of blueprints) {
    console.log(`pitch #${b.pitchId}  ${b.pitch.title}  (rated ${b.pitchRatingAtGeneration}/5 at generation, blueprinted ${b.createdAt.toISOString().slice(0, 10)})`);
  }
  console.log("\nRead one in full with: npx tsx scripts/taylorList.ts <pitch id>");
}

async function printBlueprint(pitchIdArg: string): Promise<void> {
  const pitchId = Number(pitchIdArg);
  if (!Number.isInteger(pitchId)) {
    console.error(`Invalid pitch id: ${pitchIdArg}`);
    process.exitCode = 1;
    return;
  }
  const blueprint = await prisma.tailorBlueprint.findUnique({ where: { pitchId } });
  if (!blueprint) {
    console.error(`No blueprint for pitch #${pitchId}.`);
    process.exitCode = 1;
    return;
  }
  console.log(blueprint.content);
}

async function main(): Promise<void> {
  const [pitchIdArg] = process.argv.slice(2);
  if (!pitchIdArg) {
    await listBlueprints();
  } else {
    await printBlueprint(pitchIdArg);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
