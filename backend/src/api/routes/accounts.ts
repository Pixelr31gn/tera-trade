import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";
import { currentBrokerKind } from "../../engine/accounting.js";
import { getLatestBrowserAccountSnapshot } from "../../engine/liveAccountOverride.js";

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

  // Lists every account the equity curve can be viewed for -- the single
  // shared "default" row (pre-2026-07-21 blended history, kept visible so it
  // doesn't just vanish) plus one row per real TopstepX account the browser
  // watcher has actually observed being active (see extract.ts's
  // extractActiveAccountIdentity). Lets the dashboard default its account
  // switcher to whichever one is live right now instead of always the
  // shared row (2026-07-21 fix -- equity history was blending all of an
  // operator's real accounts together under one curve).
  app.get("/api/accounts/equity-accounts", async () => {
    const defaultAccount = await ensureDefaultAccount();
    const brokerAccounts = await prisma.account.findMany({
      where: { brokerAccountId: { not: null } },
      orderBy: { id: "asc" },
    });
    const activeBrokerAccountId = getLatestBrowserAccountSnapshot()?.brokerAccountId ?? null;

    return [
      {
        id: defaultAccount.id,
        name: defaultAccount.name,
        brokerAccountId: null,
        isCurrentlyActive: false,
        startingBalance: defaultAccount.startingBalance,
      },
      ...brokerAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        brokerAccountId: a.brokerAccountId,
        isCurrentlyActive: a.brokerAccountId !== null && a.brokerAccountId === activeBrokerAccountId,
        startingBalance: a.startingBalance,
      })),
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
    // Paper and live share one account row -- without this, switching modes
    // wouldn't change the displayed equity chart at all (2026-07-15 operator
    // report), since it'd keep blending both curves together.
    const brokerKind = await currentBrokerKind();
    const rows = await prisma.equityCurvePoint.findMany({
      where: { accountId, brokerKind, time: { gte: since } },
      orderBy: { time: "asc" },
    });
    return rows.map((r) => ({ time: r.time, equity: r.equity, balance: r.balance }));
  });
}
