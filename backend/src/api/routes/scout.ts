/**
 * Dashboard access to Scout's pitches -- read the queue and submit the operator's 1-5 rating from
 * the Assistant tab instead of the terminal-only backend/scripts/scoutRate.ts (2026-09-08, operator
 * request: "the perfect place to have their env is within the assistant tab"). Mirrors that
 * script's own list/rate logic exactly (including scout/ranking.ts's computeScore) rather than
 * introducing a second, possibly-diverging implementation -- the CLI script keeps working
 * unchanged for anyone who prefers it.
 */
import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getSettings } from "../../core/config.js";
import { computeScore } from "../../scout/ranking.js";

export interface ScoutPitchView {
  id: number;
  title: string;
  problem: string;
  proposedAgent: string;
  toolsNeeded: unknown;
  costEstimate: string;
  frequencyEstimate: string;
  category: string;
  occurrenceCount: number;
  status: string;
  score: number;
  rating: number | null;
  ratingNote: string | null;
  ratedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

function toView(p: {
  id: number;
  title: string;
  problem: string;
  proposedAgent: string;
  toolsNeeded: unknown;
  costEstimate: string;
  frequencyEstimate: string;
  category: string;
  occurrenceCount: number;
  status: string;
  score: { toString(): string };
  rating: number | null;
  ratingNote: string | null;
  ratedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}): ScoutPitchView {
  return {
    id: p.id,
    title: p.title,
    problem: p.problem,
    proposedAgent: p.proposedAgent,
    toolsNeeded: p.toolsNeeded,
    costEstimate: p.costEstimate,
    frequencyEstimate: p.frequencyEstimate,
    category: p.category,
    occurrenceCount: p.occurrenceCount,
    status: p.status,
    score: Number(p.score.toString()),
    rating: p.rating,
    ratingNote: p.ratingNote,
    ratedAt: p.ratedAt?.toISOString() ?? null,
    firstSeenAt: p.firstSeenAt.toISOString(),
    lastSeenAt: p.lastSeenAt.toISOString(),
  };
}

export async function scoutRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  // Every pitch, not just "open" (unlike scoutRate.ts's terminal listing) --
  // the dashboard is the one place an operator should be able to see a
  // pitch's whole lifecycle (open -> rated -> blueprinted) at a glance, not
  // just what still needs a rating.
  app.get("/api/scout/pitches", async () => {
    const pitches = await prisma.scoutPitch.findMany({ orderBy: { score: "desc" } });
    return { pitches: pitches.map(toView), taylorApprovalMinRating: getSettings().taylorApprovalMinRating };
  });

  app.post<{ Params: { id: string }; Body: { rating: number; note?: string } }>("/api/scout/pitches/:id/rate", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid pitch id" });

    const rating = Number(request.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return reply.code(400).send({ error: "rating must be an integer 1-5" });
    }

    const existing = await prisma.scoutPitch.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: `No pitch #${id}` });

    const now = new Date();
    const score = computeScore({ occurrenceCount: existing.occurrenceCount, lastSeenAt: existing.lastSeenAt, rating }, now);
    const updated = await prisma.scoutPitch.update({
      where: { id },
      data: { rating, ratingNote: request.body.note ?? null, ratedAt: now, score: score.toFixed(4) },
    });
    return toView(updated);
  });
}
