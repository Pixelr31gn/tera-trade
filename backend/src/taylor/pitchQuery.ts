/**
 * list_approved_pitches -- Taylor's only read tool. "Approved" means the operator rated the pitch
 * >= TAYLOR_APPROVAL_MIN_RATING (default 4) -- rating is how the operator already reviews Scout's
 * output (npm run scout:rate), so reusing it as the approval signal needs no new workflow. Only
 * status="open" pitches are candidates -- "blueprinted" ones already have a TailorBlueprint (see
 * blueprintStore.ts) and won't be re-offered.
 */
import { prisma } from "../db/client.js";
import { getSettings } from "../core/config.js";
import type { ApprovedPitchSummary } from "./types.js";

export async function listApprovedPitches(): Promise<ApprovedPitchSummary[]> {
  const settings = getSettings();
  const pitches = await prisma.scoutPitch.findMany({
    where: { status: "open", rating: { gte: settings.taylorApprovalMinRating } },
    orderBy: { score: "desc" },
  });

  return pitches.map((p) => ({
    pitchId: p.id,
    title: p.title,
    problem: p.problem,
    proposedAgent: p.proposedAgent,
    toolsNeeded: Array.isArray(p.toolsNeeded) ? (p.toolsNeeded as unknown[]).map(String) : [],
    costEstimate: p.costEstimate,
    frequencyEstimate: p.frequencyEstimate,
    category: p.category,
    rating: p.rating ?? 0,
    occurrenceCount: p.occurrenceCount,
    evidenceLog: Array.isArray(p.evidenceLog) ? (p.evidenceLog as unknown as { at: string; source: string; summary: string }[]) : [],
  }));
}
