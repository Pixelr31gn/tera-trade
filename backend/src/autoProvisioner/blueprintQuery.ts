/** list_pending_blueprints -- the Auto-Provisioner's only read tool. "Pending" means Taylor wrote the blueprint but nothing has scaffolded it yet (provisioningStatus="pending", the Prisma default). */
import { prisma } from "../db/client.js";
import type { PendingBlueprintSummary } from "./types.js";

export async function listPendingBlueprints(): Promise<PendingBlueprintSummary[]> {
  const blueprints = await prisma.tailorBlueprint.findMany({
    where: { provisioningStatus: "pending" },
    include: { pitch: { select: { title: true } } },
    orderBy: { id: "asc" },
  });

  return blueprints.map((b) => ({
    blueprintId: b.id,
    pitchId: b.pitchId,
    pitchTitle: b.pitch.title,
    content: b.content,
  }));
}
