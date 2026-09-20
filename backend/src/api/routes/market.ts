import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { DEFAULT_INSTRUMENTS } from "../../marketData/instruments.js";
import { classifySession } from "../../analytics/session.js";
import { getTrendLevels } from "../../engine/trendLevelsCache.js";
import { getAllLatestOrderFlowSnapshots, getOrderFlowHistory } from "../../engine/liveOrderFlowCache.js";
import { getLatestRegimeSnapshot } from "../../engine/regimeSnapshotCache.js";
import { getPpm } from "../../engine/ppmCache.js";
import { getSupportResistanceLevels } from "../../engine/supportResistanceCache.js";

// One combined snapshot per instrument -- last price, contract specs, and
// current regime -- built for the Quick Order Panel / Watchlist so the
// frontend doesn't need to stitch together several endpoints just to know
// "what can I trade and at roughly what price right now." Shared with the
// assistant's get_market_snapshot tool.
export async function getMarketSnapshot() {
  const now = new Date();
  const session = classifySession(now);

  return Promise.all(
    DEFAULT_INSTRUMENTS.map(async (spec) => {
      const [lastBar, trendLevels] = await Promise.all([
        prisma.bar.findFirst({ where: { symbol: spec.symbol }, orderBy: { time: "desc" } }),
        getTrendLevels(spec.symbol),
      ]);
      const regimeRow = getLatestRegimeSnapshot(spec.symbol);

      return {
        symbol: spec.symbol,
        tickSize: spec.tickSize.toString(),
        pointValue: spec.pointValue.toString(),
        lastPrice: lastBar?.close ?? null,
        lastPriceTime: lastBar?.time ?? null,
        trendLabel: regimeRow?.trendLabel ?? null,
        volLabel: regimeRow?.volLabel ?? null,
        regimeConfidence: regimeRow?.confidence ?? null,
        session,
        maStack: trendLevels.maStack,
        swingHigh: trendLevels.swingHigh,
        swingLow: trendLevels.swingLow,
        swingDirection: trendLevels.swingDirection,
        fibLevels: trendLevels.fibLevels,
      };
    })
  );
}

/** Shared by GET /api/market/support-resistance and the assistant's get_support_resistance tool. */
export async function getSupportResistanceSnapshot() {
  return Promise.all(DEFAULT_INSTRUMENTS.map((spec) => getSupportResistanceLevels(spec.symbol)));
}

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/market/snapshot", async () => getMarketSnapshot());

  // Live, in-memory order-flow read directly off TopstepX's own WebSocket
  // feed (see browserWatch/orderFlowListener.ts) -- purely observational for
  // now, exposed here so the feed's accuracy can be sanity-checked visually
  // before anything in scoring is allowed to depend on it.
  app.get("/api/market/order-flow", async () => {
    return getAllLatestOrderFlowSnapshots();
  });

  // In-memory order-flow history for a symbol -- one point per flush
  // interval, bounded ring buffer (see liveOrderFlowCache.ts).
  app.get<{ Params: { symbol: string }; Querystring: { limit?: string } }>("/api/market/order-flow/:symbol/history", async (request) => {
    const { symbol } = request.params;
    const limit = Math.min(Number(request.query.limit ?? 200), 500);
    return getOrderFlowHistory(symbol, limit);
  });

  // "Points per minute" -- up vs. down speed over a rolling 15-minute
  // window, for the speed-test-style gauge (see analytics/ppm.ts).
  app.get("/api/market/ppm", async () => {
    return Promise.all(DEFAULT_INSTRUMENTS.map((spec) => getPpm(spec.symbol)));
  });

  // Support/resistance levels an entry is actually gated against (see
  // risk/engine.ts's proximity check) -- exposed so the levels are visible
  // and verifiable, not just implicit in a rejection reason string.
  app.get("/api/market/support-resistance", async () => getSupportResistanceSnapshot());
}
