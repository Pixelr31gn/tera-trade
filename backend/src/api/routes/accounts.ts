import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { BrokerKind, getSettings } from "../../core/config.js";
import { ensureAccountForBrokerKind, ensureDefaultAccount } from "../../engine/bootstrap.js";
import { brokerKindForAccount } from "../../engine/accounting.js";
import { getLatestBrowserAccountSnapshot } from "../../engine/liveAccountOverride.js";
import type { ActionResult } from "./trades.js";

async function accountWithRiskLimits(account: { id: number; name: string; startingBalance: unknown }) {
  const limits = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
  return {
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
  };
}

export interface RiskLimitsUpdateBody {
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

export interface RiskLimitsUpdateResult {
  status: "updated";
}

/**
 * Shared by the dashboard's risk-limits form and (2026-08-28) the
 * assistant's update_risk_limits tool -- one implementation. Reshapes sizing
 * for every future trade on this account until changed again, not just one
 * trade -- CLAUDE.md's "say what evidence supports it" convention for tuned
 * constants applies here as much as it does to the hand-set constants in code.
 */
export async function updateRiskLimits(accountId: number, body: RiskLimitsUpdateBody): Promise<ActionResult<RiskLimitsUpdateResult>> {
  const existing = await prisma.riskLimit.findUnique({ where: { accountId } });
  if (!existing) return { ok: false, statusCode: 404, error: "No risk limits configured for this account" };

  await prisma.riskLimit.update({
    where: { accountId },
    data: {
      perTradeRiskPct: body.perTradeRiskPct.toString(),
      maxDailyLossPct: body.maxDailyLossPct.toString(),
      maxTrailingDrawdownPct: body.maxTrailingDrawdownPct.toString(),
      maxPositionSize: body.maxPositionSize,
      maxConsecutiveLosses: body.maxConsecutiveLosses,
      maxDailyTrades: body.maxDailyTrades,
      perTradeRiskDollars: body.perTradeRiskDollars?.toString() ?? null,
      perTradeProfitDollars: body.perTradeProfitDollars?.toString() ?? null,
      maxDailyLossDollars: body.maxDailyLossDollars?.toString() ?? null,
    },
  });
  return { ok: true, data: { status: "updated" } };
}

/** Shared by GET /api/accounts and the assistant's get_accounts tool. */
export async function getAccountsList() {
  const account = await ensureDefaultAccount();
  const rows = [await accountWithRiskLimits(account)];
  // Tradesea gets its own row here too (each with its own risk limits) --
  // added 2026-08-28 so its account is visible/selectable the same way the
  // primary one always has been, not silently left out of the one route
  // that lists accounts-with-risk-limits.
  if (getSettings().tradeseaEnabled) {
    const tradeseaAccount = await ensureAccountForBrokerKind(BrokerKind.TRADESEA_BROWSER_CONTROL);
    rows.push(await accountWithRiskLimits(tradeseaAccount));
  }
  return rows;
}

/** Shared by GET /api/accounts/:accountId/equity-curve and the assistant's get_equity_curve tool. Returns null if the account doesn't exist. */
export async function getEquityCurve(accountId: number, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return null;
  // Paper and live share one account row -- without this, switching modes
  // wouldn't change the displayed equity chart at all (2026-07-15 operator
  // report), since it'd keep blending both curves together. Tradesea's
  // account is different (its brokerKind is fixed, not mode-dependent) --
  // see brokerKindForAccount's own comment for why this can't just be
  // currentBrokerKind() unconditionally.
  const brokerKind = await brokerKindForAccount(account);
  // 2026-09-10: an exact brokerKind match here broke the moment BROKER_KIND switched from
  // browser_control to projectx mid-session -- every existing equity point was stamped
  // "browser_control", none matched "projectx", and the chart went empty. See
  // api/routes/trades.ts's identical fix for the full incident writeup. Simulated and Tradesea
  // still need an exact match; only the two TopstepX-access-method kinds are broadened.
  const brokerKindsToQuery: string[] =
    brokerKind === BrokerKind.SIMULATED || brokerKind === BrokerKind.TRADESEA_BROWSER_CONTROL
      ? [brokerKind]
      : [BrokerKind.PROJECTX, BrokerKind.BROWSER_CONTROL];
  const rows = await prisma.equityCurvePoint.findMany({
    where: { accountId, brokerKind: { in: brokerKindsToQuery }, time: { gte: since } },
    orderBy: { time: "asc" },
  });
  return rows.map((r) => ({ time: r.time, equity: r.equity, balance: r.balance }));
}

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/accounts", async () => getAccountsList());

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
    const tradeseaAccount = getSettings().tradeseaEnabled ? await ensureAccountForBrokerKind(BrokerKind.TRADESEA_BROWSER_CONTROL) : null;

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
      // Tradesea has no brokerAccountId concept (no "operator switches
      // between several real accounts in this browser" the way TopstepX
      // does) -- always active whenever it's connected, added directly
      // rather than fitting into the brokerAccounts query above.
      ...(tradeseaAccount ? [{ id: tradeseaAccount.id, name: tradeseaAccount.name, brokerAccountId: null, isCurrentlyActive: true, startingBalance: tradeseaAccount.startingBalance }] : []),
    ];
  });

  app.patch<{ Params: { accountId: string }; Body: RiskLimitsUpdateBody }>("/api/accounts/:accountId/risk-limits", async (request, reply) => {
    const result = await updateRiskLimits(Number(request.params.accountId), request.body);
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return result.data;
  });

  app.get<{ Params: { accountId: string }; Querystring: { days?: string } }>("/api/accounts/:accountId/equity-curve", async (request, reply) => {
    const result = await getEquityCurve(Number(request.params.accountId), Number(request.query.days ?? 30));
    if (result === null) return reply.code(404).send({ error: "No such account" });
    return result;
  });
}
