/**
 * write_pitch -- the one tool that writes durable state, into the ScoutPitch table (schema.prisma
 * calls it the "signal store": see that model's header comment). Upserts by a slugified-title
 * fingerprint so the same recurring friction, described slightly differently across separate
 * Scout ticks, still collides onto one row instead of spawning duplicates.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { computeScore } from "./ranking.js";
import type { EvidenceLogEntry, WritePitchInput } from "./types.js";

/** JSON round-trip so a plain interface (not an index-signature type) satisfies Prisma's InputJsonValue -- same pattern as assistant/client.ts's toJsonSafe. */
function toJsonSafe(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

// Bounds evidenceLog's growth on a long-lived, frequently-reinforced pitch -- the ranking only
// ever needs occurrenceCount/lastSeenAt (both separate columns, unbounded), not an unbounded
// history of every past observation. Keeps the newest entries (most useful for the digest).
const EVIDENCE_LOG_MAX_ENTRIES = 20;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface WritePitchResult {
  pitchId: number;
  dedupeKey: string;
  wasNew: boolean;
  occurrenceCount: number;
  score: number;
}

export async function writePitch(input: WritePitchInput): Promise<WritePitchResult> {
  const dedupeKey = slugify(input.title);
  if (!dedupeKey) throw new Error("title must contain at least one alphanumeric character");

  const now = new Date();
  const evidenceEntry: EvidenceLogEntry = { at: now.toISOString(), source: input.evidenceSource, summary: input.evidenceSummary };

  const existing = await prisma.scoutPitch.findUnique({ where: { dedupeKey } });

  if (!existing) {
    const score = computeScore({ occurrenceCount: 1, lastSeenAt: now, rating: null }, now);
    const created = await prisma.scoutPitch.create({
      data: {
        dedupeKey,
        title: input.title,
        problem: input.problem,
        proposedAgent: input.proposedAgent,
        toolsNeeded: input.toolsNeeded,
        costEstimate: input.costEstimate,
        frequencyEstimate: input.frequencyEstimate,
        category: input.category,
        evidenceLog: toJsonSafe([evidenceEntry]),
        occurrenceCount: 1,
        score: score.toFixed(4),
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    return { pitchId: created.id, dedupeKey, wasNew: true, occurrenceCount: 1, score };
  }

  const priorLog = Array.isArray(existing.evidenceLog) ? (existing.evidenceLog as unknown as EvidenceLogEntry[]) : [];
  const nextLog = [...priorLog, evidenceEntry].slice(-EVIDENCE_LOG_MAX_ENTRIES);
  const occurrenceCount = existing.occurrenceCount + 1;
  const score = computeScore({ occurrenceCount, lastSeenAt: now, rating: existing.rating }, now);

  const updated = await prisma.scoutPitch.update({
    where: { id: existing.id },
    data: {
      // Description fields refresh to the latest call's wording -- Scout's own read of a
      // recurring pitch tends to sharpen as more evidence comes in, and there's no value in
      // freezing the very first (often thinnest) draft while evidenceLog below keeps the history.
      problem: input.problem,
      proposedAgent: input.proposedAgent,
      toolsNeeded: input.toolsNeeded,
      costEstimate: input.costEstimate,
      frequencyEstimate: input.frequencyEstimate,
      category: input.category,
      evidenceLog: toJsonSafe(nextLog),
      occurrenceCount,
      score: score.toFixed(4),
      lastSeenAt: now,
    },
  });
  return { pitchId: updated.id, dedupeKey, wasNew: false, occurrenceCount, score };
}
