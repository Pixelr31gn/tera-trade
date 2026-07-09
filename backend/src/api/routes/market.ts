import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { DEFAULT_INSTRUMENTS } from "../../marketData/instruments.js";
import { classifySession } from "../../analytics/session.js";

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  // One combined snapshot per instrument -- last price, contract specs, and
  // current regime -- built for the Quick Order Panel / Watchlist so the
  // frontend doesn't need to stitch together several endpoints just to know
  // "what can I trade and at roughly what price right now."
  app.get("/api/market/snapshot", async () => {
    const now = new Date();
    const session = classifySession(now);

    const out = [];
    for (const spec of DEFAULT_INSTRUMENTS) {
      const [lastBar, regimeRow] = await Promise.all([
        prisma.bar.findFirst({ where: { symbol: spec.symbol }, orderBy: { time: "desc" } }),
        prisma.regimeSnapshot.findFirst({ where: { symbol: spec.symbol }, orderBy: { time: "desc" } }),
      ]);

      out.push({
        symbol: spec.symbol,
        tickSize: spec.tickSize.toString(),
        pointValue: spec.pointValue.toString(),
        lastPrice: lastBar?.close ?? null,
        lastPriceTime: lastBar?.time ?? null,
        trendLabel: regimeRow?.trendLabel ?? null,
        volLabel: regimeRow?.volLabel ?? null,
        regimeConfidence: regimeRow?.confidence ?? null,
        session,
      });
    }
    return out;
  });
}
