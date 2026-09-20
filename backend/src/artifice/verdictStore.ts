/**
 * write_verdict -- Artifice's only write tool. Upserts ArtificeVerdict for one blueprint (keyed by
 * blueprintId, same "re-run reinforces, doesn't duplicate" posture as Scout's writePitch and
 * Taylor's writeBlueprint). Once a blueprint has a verdict, listUntriagedBlueprints stops
 * re-offering it -- re-triaging one on purpose means deleting its ArtificeVerdict row first.
 */
import { prisma } from "../db/client.js";
import type { WriteVerdictInput } from "./types.js";

export interface WriteVerdictResult {
  verdictId: number;
  blueprintId: number;
  verdict: string;
}

export async function writeVerdict(input: WriteVerdictInput): Promise<WriteVerdictResult> {
  const blueprint = await prisma.tailorBlueprint.findUnique({ where: { id: input.blueprintId } });
  if (!blueprint) {
    throw new Error(`No blueprint #${input.blueprintId} -- call list_untriaged_blueprints first and use one of the blueprintId values it returns.`);
  }

  if (input.verdict === "merge") {
    if (!input.mergeIntoBlueprintId) {
      throw new Error(`verdict "merge" requires mergeIntoBlueprintId -- which other blueprint already covers #${input.blueprintId}?`);
    }
    if (input.mergeIntoBlueprintId === input.blueprintId) {
      throw new Error(`mergeIntoBlueprintId can't be the same blueprint #${input.blueprintId} -- a blueprint can't merge into itself.`);
    }
    const target = await prisma.tailorBlueprint.findUnique({ where: { id: input.mergeIntoBlueprintId } });
    if (!target) {
      throw new Error(`mergeIntoBlueprintId #${input.mergeIntoBlueprintId} doesn't exist -- use a real blueprintId from list_untriaged_blueprints.`);
    }
  }

  const verdict = await prisma.artificeVerdict.upsert({
    where: { blueprintId: input.blueprintId },
    create: {
      blueprintId: input.blueprintId,
      verdict: input.verdict,
      mergeIntoBlueprintId: input.verdict === "merge" ? input.mergeIntoBlueprintId : null,
      reasoning: input.reasoning,
    },
    update: {
      verdict: input.verdict,
      mergeIntoBlueprintId: input.verdict === "merge" ? input.mergeIntoBlueprintId : null,
      reasoning: input.reasoning,
    },
  });

  return { verdictId: verdict.id, blueprintId: input.blueprintId, verdict: input.verdict };
}
