import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../../core/security.js";
import { DEFAULT_INSTRUMENTS } from "../../marketData/instruments.js";
import { getLatestRegimeSnapshot } from "../../engine/regimeSnapshotCache.js";

export async function regimeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/regime/current", async () => {
    const out: Record<string, unknown> = {};
    for (const spec of DEFAULT_INSTRUMENTS) {
      const row = getLatestRegimeSnapshot(spec.symbol);
      if (row) {
        out[spec.symbol] = { time: row.time, trendLabel: row.trendLabel, volLabel: row.volLabel, confidence: row.confidence, features: row.features };
      }
    }
    return out;
  });
}
