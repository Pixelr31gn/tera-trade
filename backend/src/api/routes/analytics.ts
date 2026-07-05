import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../../core/security.js";
import { getOpeningRangeStats } from "../../engine/openingRangeCache.js";
import { DEFAULT_INSTRUMENTS } from "../../marketData/instruments.js";

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { symbol?: string } }>("/api/analytics/opening-range", async (request) => {
    const symbols = request.query.symbol ? [request.query.symbol] : DEFAULT_INSTRUMENTS.map((i) => i.symbol);
    const results: Record<string, Awaited<ReturnType<typeof getOpeningRangeStats>>> = {};
    for (const symbol of symbols) {
      results[symbol] = await getOpeningRangeStats(symbol);
    }
    return results;
  });
}
