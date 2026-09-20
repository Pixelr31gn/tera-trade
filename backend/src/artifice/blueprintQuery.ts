/**
 * Artifice's two read tools. list_untriaged_blueprints returns every TailorBlueprint that doesn't
 * have an ArtificeVerdict yet, ALL AT ONCE -- not one at a time -- specifically so Artifice can
 * compare them against each other in a single turn and catch e.g. three blueprints that turn out
 * to be the same underlying idea proposed three times (this is exactly what a same-turn, one-at-a-
 * time review misses). get_session_performance hands over the same real, already-computed data
 * crossRegimeAnalyzer itself reads, so a blueprint's own cited evidence (an avgR figure, a sample
 * size) can be checked against reality instead of taken on faith.
 */
import { prisma } from "../db/client.js";
import { computeSessionPerformanceForAllSessions } from "../api/routes/analytics.js";
import type { UntriagedBlueprint } from "./types.js";

export async function listUntriagedBlueprints(): Promise<UntriagedBlueprint[]> {
  const rows = await prisma.tailorBlueprint.findMany({
    where: { artificeVerdict: null },
    include: { pitch: true },
    orderBy: { id: "asc" },
  });
  return rows.map((b) => ({
    blueprintId: b.id,
    pitchId: b.pitchId,
    pitchTitle: b.pitch.title,
    pitchCategory: b.pitch.category,
    pitchRating: b.pitch.rating,
    content: b.content,
  }));
}

/** Real, current regime/liquidity/price-action performance breakdown, per session -- same function crossRegimeAnalyzer/scan.ts calls, cached the same way (see analytics.ts's own `cached()`). */
export async function getSessionPerformance(): Promise<Awaited<ReturnType<typeof computeSessionPerformanceForAllSessions>>> {
  return computeSessionPerformanceForAllSessions();
}
