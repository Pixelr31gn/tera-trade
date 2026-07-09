import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";

interface RiskLimitsUpdateBody {
  perTradeRiskPct: number;
  maxDailyLossPct: number;
  maxTrailingDrawdownPct: number;
  maxPositionSize: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  perTradeRiskDollars: number | null;
  perTradeProfitDollars: number | null;
  maxDailyLossDollars: number | null;
}

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/accounts", async () => {
    const account = await ensureDefaultAccount();
    const limits = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
    return [
      {
        id: account.id,
        name: account.name,
        startingBalance: account.startingBalance,
        riskLimits: {
          perTradeRiskPct: limits.perTradeRiskPct,
          maxDailyLossPct: limits.maxDailyLossPct,
          maxTrailingDrawdownPct: limits.maxTrailingDrawdownPct,
          maxPositionSize: limits.maxPositionSize,
          maxConsecutiveLosses: limits.maxConsecutiveLosses,
          maxDailyTrades: limits.maxDailyTrades,
          perTradeRiskDollars: limits.perTradeRiskDollars,
          perTradeProfitDollars: limits.perTradeProfitDollars,
          maxDailyLossDollars: limits.maxDailyLossDollars,
        },
      },
    ];
  });

  app.patch<{ Params: { accountId: string }; Body: RiskLimitsUpdateBody }>("/api/accounts/:accountId/risk-limits", async (request, reply) => {
    const accountId = Number(request.params.accountId);
    const existing = await prisma.riskLimit.findUnique({ where: { accountId } });
    if (!existing) return reply.code(404).send({ error: "No risk limits configured for this account" });

    const b = request.body;
    await prisma.riskLimit.update({
      where: { accountId },
      data: {
        perTradeRiskPct: b.perTradeRiskPct.toString(),
        maxDailyLossPct: b.maxDailyLossPct.toString(),
        maxTrailingDrawdownPct: b.maxTrailingDrawdownPct.toString(),
        maxPositionSize: b.maxPositionSize,
        maxConsecutiveLosses: b.maxConsecutiveLosses,
        maxDailyTrades: b.maxDailyTrades,
        perTradeRiskDollars: b.perTradeRiskDollars?.toString() ?? null,
        perTradeProfitDollars: b.perTradeProfitDollars?.toString() ?? null,
        maxDailyLossDollars: b.maxDailyLossDollars?.toString() ?? null,
      },
    });
    return { status: "updated" };
  });

  app.get<{ Params: { accountId: string }; Querystring: { days?: string } }>("/api/accounts/:accountId/equity-curve", async (request) => {
    const accountId = Number(request.params.accountId);
    const days = Number(request.query.days ?? 30);
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await prisma.equityCurvePoint.findMany({
      where: { accountId, time: { gte: since } },
      orderBy: { time: "asc" },
    });
    return rows.map((r) => ({ time: r.time, equity: r.equity, balance: r.balance }));
  });
}
