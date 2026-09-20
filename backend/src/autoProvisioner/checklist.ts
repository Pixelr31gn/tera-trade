/**
 * Writes CHECKLIST.md into the staged scaffold directory and records the outcome on
 * TailorBlueprint. This IS the "human-in-the-loop approval" step from the pitch's own framing --
 * a file for a human to read, not a Slack/Discord webhook (no webhook is configured anywhere in
 * this repo; adding one would be a new external dependency this task doesn't need -- see
 * systemPrompt.ts's header comment).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../db/client.js";
import type { ProvisioningStatus, ValidationResult } from "./types.js";

function renderChecklist(opts: {
  pitchId: number;
  pitchTitle: string;
  filesWritten: string[];
  modelNotes: string;
  typeCheck: ValidationResult;
  stagingDirRepoRelative: string;
}): string {
  const lines: string[] = [
    `# Deployment checklist -- ${opts.pitchTitle}`,
    "",
    `Source pitch: #${opts.pitchId} | Staged at: \`${opts.stagingDirRepoRelative}\``,
    "",
    "This code was scaffolded by the Auto-Provisioner from Taylor's blueprint. It has NOT been",
    "committed, pushed, or wired into anything live -- that only happens if you do it. Review",
    "before doing any of that.",
    "",
    "## Files written",
    "",
    ...opts.filesWritten.map((f) => `- \`${f}\``),
    "",
    "## Model's own notes",
    "",
    opts.modelNotes || "(none provided)",
    "",
    `## tsc --noEmit: ${opts.typeCheck.ok ? "PASSED" : "FAILED"}`,
    "",
    "```",
    opts.typeCheck.output.slice(0, 4000),
    "```",
    "",
    "## Before this goes anywhere real",
    "",
    "- [ ] Read every file -- this is a first-draft scaffold from a local LLM, not reviewed code.",
    "- [ ] Confirm it never imports from risk/, execution/, or brokers/ unless the blueprint",
    "      specifically called for that (it shouldn't have, for a Scout-pitched analysis/tooling agent).",
    "- [ ] If tsc failed above, fix the errors -- this was not auto-fixed.",
    "- [ ] Move the directory out of backend/src/_provisioned/ into a real top-level agent",
    "      directory (e.g. backend/src/<name>/) once you're satisfied with it -- it stays gitignored",
    "      and inert until you do.",
    "- [ ] Add any new config/env vars it needs to core/config.ts, following the existing pattern.",
    "- [ ] Add npm scripts + a supervisor .ps1 if it should run continuously (see scout/taylor's own).",
    "- [ ] Run `npm test` before considering this done.",
    "- [ ] You decide whether/when to `git add` and commit -- nothing here does that automatically.",
  ];
  return lines.join("\n");
}

export interface RecordOutcomeInput {
  blueprintId: number;
  pitchId: number;
  pitchTitle: string;
  stagingDirAbsolute: string;
  stagingDirRepoRelative: string;
  filesWritten: string[];
  modelNotes: string;
  typeCheck: ValidationResult;
}

export async function recordProvisioningOutcome(input: RecordOutcomeInput): Promise<{ status: ProvisioningStatus; checklistPath: string }> {
  const checklist = renderChecklist({
    pitchId: input.pitchId,
    pitchTitle: input.pitchTitle,
    filesWritten: input.filesWritten,
    modelNotes: input.modelNotes,
    typeCheck: input.typeCheck,
    stagingDirRepoRelative: input.stagingDirRepoRelative,
  });
  const checklistPath = path.join(input.stagingDirAbsolute, "CHECKLIST.md");
  writeFileSync(checklistPath, checklist, "utf8");

  const status: ProvisioningStatus = input.typeCheck.ok ? "staged" : "lint_failed";
  await prisma.tailorBlueprint.update({
    where: { id: input.blueprintId },
    data: {
      provisioningStatus: status,
      provisionedPath: input.stagingDirRepoRelative,
      provisioningNotes: input.typeCheck.output.slice(0, 8000),
      provisionedAt: new Date(),
    },
  });

  return { status, checklistPath };
}

export async function recordProvisioningError(blueprintId: number, errorMessage: string): Promise<void> {
  await prisma.tailorBlueprint.update({
    where: { id: blueprintId },
    data: {
      provisioningStatus: "error",
      provisioningNotes: errorMessage.slice(0, 8000),
      provisionedAt: new Date(),
    },
  });
}
