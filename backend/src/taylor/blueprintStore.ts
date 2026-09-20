/**
 * write_blueprint -- Taylor's only write tool. Upserts TailorBlueprint for one pitch and flips
 * that pitch's status to "blueprinted" (so list_approved_pitches stops re-offering it). Renders
 * the structured input into markdown server-side (same posture as scout/digest.ts) rather than
 * trusting the model to produce consistently-formatted markdown itself.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../db/client.js";
import { ensureBlueprintDir, BLUEPRINT_DIR } from "./state.js";
import { slugify } from "../scout/pitchStore.js";
import type { WriteBlueprintInput } from "./types.js";

function renderMarkdown(pitchTitle: string, input: WriteBlueprintInput): string {
  const lines: string[] = [
    `# Build blueprint -- ${pitchTitle}`,
    "",
    `Source pitch: #${input.pitchId}`,
    "",
    "## Overview",
    "",
    input.overview,
    "",
    "## Architecture",
    "",
    input.architecture,
    "",
    "## Data model changes",
    "",
    input.dataModelChanges,
    "",
    "## Tool definitions",
    "",
  ];
  if (input.toolDefinitions.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of input.toolDefinitions) lines.push(`- **${t.name}**: ${t.description}`);
  }
  lines.push("", "## Implementation steps", "");
  if (input.implementationSteps.length === 0) {
    lines.push("(none)");
  } else {
    input.implementationSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  lines.push("", "## Open questions", "");
  if (input.openQuestions.length === 0) {
    lines.push("(none)");
  } else {
    for (const q of input.openQuestions) lines.push(`- ${q}`);
  }
  return lines.join("\n");
}

export interface WriteBlueprintResult {
  blueprintId: number;
  pitchId: number;
  filePath: string;
}

export async function writeBlueprint(input: WriteBlueprintInput): Promise<WriteBlueprintResult> {
  const pitch = await prisma.scoutPitch.findUnique({ where: { id: input.pitchId } });
  if (!pitch) throw new Error(`No pitch #${input.pitchId} -- call list_approved_pitches first and use one of the pitchId values it returns.`);
  if (pitch.rating === null) throw new Error(`Pitch #${input.pitchId} has no rating -- only approved (rated) pitches can be blueprinted.`);

  const content = renderMarkdown(pitch.title, input);

  const blueprint = await prisma.tailorBlueprint.upsert({
    where: { pitchId: input.pitchId },
    create: { pitchId: input.pitchId, content, pitchRatingAtGeneration: pitch.rating },
    update: { content, pitchRatingAtGeneration: pitch.rating },
  });

  await prisma.scoutPitch.update({ where: { id: input.pitchId }, data: { status: "blueprinted" } });

  ensureBlueprintDir();
  const filePath = path.join(BLUEPRINT_DIR, `${input.pitchId}-${slugify(pitch.title)}.md`);
  writeFileSync(filePath, content, "utf8");

  return { blueprintId: blueprint.id, pitchId: input.pitchId, filePath };
}
