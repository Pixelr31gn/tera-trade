/**
 * compile_digest -- renders the current ScoutPitch ranking to markdown, writes it both to the DB
 * (ScoutDigest, the durable record) and to disk (.scout-state/digests/YYYY-MM-DD.md, for reading
 * without a DB client). Runs once at end of day (scout/scheduler.ts) -- "surfaced once a day, not
 * real-time," per the operator's own requirement. Never deletes or mutates ScoutPitch rows; this
 * is a read + render only.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../db/client.js";
import { ensureDigestDir, SCOUT_DIGEST_DIR } from "./state.js";

const DIGEST_TOP_N = 15;

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function renderMarkdown(dateKey: string, pitches: { id: number; title: string; problem: string; proposedAgent: string; toolsNeeded: unknown; costEstimate: string; frequencyEstimate: string; category: string; occurrenceCount: number; score: unknown; rating: number | null; firstSeenAt: Date; lastSeenAt: Date }[]): string {
  const lines: string[] = [`# Scout digest -- ${dateKey}`, ""];
  if (pitches.length === 0) {
    lines.push("No open pitches yet.");
    return lines.join("\n");
  }
  lines.push(`${pitches.length} pitch(es), ranked by current score. Rate any of these with \`npm run scout:rate -- <id> <1-5> ["note"]\` (run from backend/).`, "");

  pitches.forEach((p, i) => {
    const tools = Array.isArray(p.toolsNeeded) ? (p.toolsNeeded as unknown[]).join(", ") : String(p.toolsNeeded);
    const ratingText = p.rating === null ? "unrated" : `${p.rating}/5${p.rating !== null ? "" : ""}`;
    lines.push(
      `## ${i + 1}. ${p.title} (#${p.id})`,
      "",
      `- **Category:** ${p.category}`,
      `- **Seen:** ${p.occurrenceCount}x -- first ${localDateKey(p.firstSeenAt)}, last ${localDateKey(p.lastSeenAt)}`,
      `- **Score:** ${Number(p.score).toFixed(2)}`,
      `- **Rating:** ${ratingText}`,
      "",
      `**Problem:** ${p.problem}`,
      "",
      `**Proposed agent:** ${p.proposedAgent}`,
      "",
      `**Tools needed:** ${tools}`,
      "",
      `**Cost estimate:** ${p.costEstimate}  `,
      `**Run frequency:** ${p.frequencyEstimate}`,
      ""
    );
  });

  return lines.join("\n");
}

export interface CompileDigestResult {
  digestDate: string;
  pitchCount: number;
  filePath: string;
  content: string;
}

export async function compileDigest(now: Date = new Date()): Promise<CompileDigestResult> {
  const dateKey = localDateKey(now);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const pitches = await prisma.scoutPitch.findMany({
    where: { status: "open" },
    orderBy: { score: "desc" },
    take: DIGEST_TOP_N,
  });

  const content = renderMarkdown(dateKey, pitches);
  const pitchSnapshot = pitches.map((p, i) => ({ pitchId: p.id, rank: i + 1, score: Number(p.score) }));

  await prisma.scoutDigest.upsert({
    where: { digestDate: dayStart },
    create: { digestDate: dayStart, content, pitchSnapshot },
    update: { content, pitchSnapshot },
  });

  ensureDigestDir();
  const filePath = path.join(SCOUT_DIGEST_DIR, `${dateKey}.md`);
  writeFileSync(filePath, content, "utf8");

  return { digestDate: dateKey, pitchCount: pitches.length, filePath, content };
}
