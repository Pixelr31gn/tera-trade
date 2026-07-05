import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { computePortfolioStats, computeTradeStats } from "../../analytics/stats.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";

export async function performanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/performance/summary", async () => {
    const account = await ensureDefaultAccount();

    const closed = await prisma.trade.findMany({ where: { accountId: account.id, status: "closed" } });
    const tradeStats = computeTradeStats(
      closed.map((t) => ({ pnl: Number(t.pnl ?? 0), mae: t.mae !== null ? Number(t.mae) : null, mfe: t.mfe !== null ? Number(t.mfe) : null }))
    );

    const equityRows = await prisma.equityCurvePoint.findMany({ where: { accountId: account.id }, orderBy: { time: "asc" } });
    const portfolioStats = computePortfolioStats(equityRows.map((r) => Number(r.equity)));

    const byStrategy = new Map<string, number[]>();
    const byRegime = new Map<string, number[]>();
    for (const t of closed) {
      const pnl = Number(t.pnl ?? 0);
      byStrategy.set(t.strategyId, [...(byStrategy.get(t.strategyId) ?? []), pnl]);
      const key = `${t.regimeTrendAtEntry}/${t.regimeVolAtEntry}`;
      byRegime.set(key, [...(byRegime.get(key) ?? []), pnl]);
    }

    const bucketSummary = (buckets: Map<string, number[]>) =>
      Object.fromEntries(
        [...buckets.entries()].map(([k, v]) => [
          k,
          { tradeCount: v.length, totalPnl: v.reduce((a, b) => a + b, 0), winRate: v.length ? v.filter((x) => x > 0).length / v.length : 0 },
        ])
      );

    return {
      tradeStats,
      portfolioStats,
      byStrategy: bucketSummary(byStrategy),
      byRegime: bucketSummary(byRegime),
    };
  });
}
