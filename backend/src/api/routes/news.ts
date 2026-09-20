import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getNewsRiskStatus } from "../../news/risk.js";

/** Shared by GET /api/news/upcoming and the assistant's get_news_upcoming tool. */
export async function getUpcomingNews() {
  const now = new Date();
  const rows = await prisma.newsEvent.findMany({
    where: { eventTime: { gte: new Date(now.getTime() - 6 * 3_600_000), lte: new Date(now.getTime() + 7 * 86_400_000) } },
    orderBy: { eventTime: "asc" },
  });
  return rows.map((r) => ({ time: r.eventTime, country: r.country, name: r.name, impact: r.impact, forecast: r.forecast, previous: r.previous }));
}

export async function newsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/news/upcoming", async () => getUpcomingNews());

  app.get("/api/news/risk-status", async () => {
    return getNewsRiskStatus();
  });
}
