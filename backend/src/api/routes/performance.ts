import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { computePortfolioStats, computeTradeStats } from "../../analytics/stats.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";
import { currentBrokerKind } from "../../engine/accounting.js";

export async function performanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/performance/summary", async () => {
    const account = await ensureDefaultAccount();
    // Paper and live share one account row -- without this, a paper run's
    // stats would silently blend with real trade history (2026-07-15
    // operator report: switching modes didn't change the displayed balance
    // at all, traced to this same missing filter across several endpoints).
    const brokerKind = await currentBrokerKind();

    const closed = await prisma.trade.findMany({ where: { accountId: account.id, status: "closed", brokerKind } });
    const tradeStats = computeTradeStats(
      closed.map((t) => ({ pnl: Number(t.pnl ?? 0), mae: t.mae !== null ? Number(t.mae) : null, mfe: t.mfe !== null ? Number(t.mfe) : null }))
    );

    // Equity points used to be written on every price tick (~5-10s), so
    // this table can carry far more resolution than Sharpe/drawdown/CAGR
    // need -- capped here as a safety net regardless of how much history
    // has piled up (see engine/loop.ts's EQUITY_POINT_MIN_INTERVAL_MS for
    // the actual fix to new writes).
    const equityRowsDesc = await prisma.equityCurvePoint.findMany({
      where: { accountId: account.id, brokerKind },
      orderBy: { time: "desc" },
      take: 5000,
    });
    const portfolioStats = computePortfolioStats(equityRowsDesc.map((r) => Number(r.equity)).reverse());

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
