/**
 * Dashboard access to Taylor's blueprints -- mirrors backend/scripts/taylorList.ts's own list/read
 * logic exactly (2026-09-08, see api/routes/scout.ts's header comment for the full request this
 * and that file share).
 */
import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";

export interface TailorBlueprintView {
  pitchId: number;
  pitchTitle: string;
  pitchRatingAtGeneration: number;
  createdAt: string;
}

export async function taylorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/taylor/blueprints", async () => {
    const blueprints = await prisma.tailorBlueprint.findMany({
      include: { pitch: { select: { title: true } } },
      orderBy: { createdAt: "desc" },
    });
    return blueprints.map(
      (b): TailorBlueprintView => ({
        pitchId: b.pitchId,
        pitchTitle: b.pitch.title,
        pitchRatingAtGeneration: b.pitchRatingAtGeneration,
        createdAt: b.createdAt.toISOString(),
      })
    );
  });

  app.get<{ Params: { pitchId: string } }>("/api/taylor/blueprints/:pitchId", async (request, reply) => {
    const pitchId = Number(request.params.pitchId);
    if (!Number.isInteger(pitchId)) return reply.code(400).send({ error: "Invalid pitch id" });
    const blueprint = await prisma.tailorBlueprint.findUnique({ where: { pitchId } });
    if (!blueprint) return reply.code(404).send({ error: `No blueprint for pitch #${pitchId}` });
    return { pitchId: blueprint.pitchId, content: blueprint.content };
  });
}
