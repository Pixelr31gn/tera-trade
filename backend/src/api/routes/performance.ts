import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { computePortfolioStats, computeTradeStats } from "../../analytics/stats.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";
import { brokerKindForAccount } from "../../engine/accounting.js";
import { BrokerKind } from "../../core/config.js";

/**
 * Shared by GET /api/performance/summary and the assistant's
 * get_performance_summary tool -- one implementation.
 */
export async function getPerformanceSummary(accountId?: number) {
    // accountId (2026-08-28): optional, defaults to the primary account --
    // pass Tradesea's own account id to see its performance instead.
    const account = accountId
      ? await prisma.account.findUniqueOrThrow({ where: { id: accountId } })
      : await ensureDefaultAccount();
    // Paper and live share one account row -- without this, a paper run's
    // stats would silently blend with real trade history (2026-07-15
    // operator report: switching modes didn't change the displayed balance
    // at all, traced to this same missing filter across several endpoints).
    // Tradesea's account is different (fixed brokerKind, not mode-dependent)
    // -- see brokerKindForAccount's own comment.
    const brokerKind = await brokerKindForAccount(account);
    // 2026-09-10: an exact brokerKind match here broke the moment BROKER_KIND switched from
    // browser_control to projectx mid-session -- every existing closed trade/equity point was
    // stamped "browser_control", none matched "projectx", and performance/equity both silently
    // went to zero. See api/routes/trades.ts's identical fix for the full incident writeup.
    // Simulated and Tradesea still need an exact match; only the two TopstepX-access-method kinds
    // are broadened to match either.
    const brokerKindsToQuery: string[] =
      brokerKind === BrokerKind.SIMULATED || brokerKind === BrokerKind.TRADESEA_BROWSER_CONTROL
        ? [brokerKind]
        : [BrokerKind.PROJECTX, BrokerKind.BROWSER_CONTROL];

    const closed = await prisma.trade.findMany({ where: { accountId: account.id, status: "closed", brokerKind: { in: brokerKindsToQuery } } });
    const tradeStats = computeTradeStats(
      closed.map((t) => ({ pnl: Number(t.pnl ?? 0), mae: t.mae !== null ? Number(t.mae) : null, mfe: t.mfe !== null ? Number(t.mfe) : null }))
    );

    // Equity points used to be written on every price tick (~5-10s), so
    // this table can carry far more resolution than Sharpe/drawdown/CAGR
    // need -- capped here as a safety net regardless of how much history
    // has piled up (see engine/loop.ts's EQUITY_POINT_MIN_INTERVAL_MS for
    // the actual fix to new writes).
    //
    // A confirmed, one-off corrupted window is excluded here (2026-08-11,
    // operator report: "make sure this calculates properly" -- dashboard
    // showed Max Drawdown 100.9%, Sharpe/Sortino/Volatility all blank).
    // account 1/browser_control's equity_curve shows a real, isolated
    // incident on 2026-07-20: equity read $97,860.11 at 14:26:23, then
    // crashed through $0 down to -$873.42 and hovered in the low hundreds
    // (still wildly wrong, just not negative -- stats.ts's non-positive
    // filter alone doesn't catch this part) until genuinely recovering to
    // $98,516.50 at 16:13:37 -- with ZERO trades executing anywhere in that
    // ~1h37m window (cross-checked against the trades table). Not real
    // P&L; a data-quality artifact consistent with the browser-scraping/
    // account-identity bugs this project's own history documents being
    // hardened away in the days after (per-account equity separation,
    // Chrome page-detection hardening). The underlying rows are left in
    // place (not deleted) as a historical record -- only excluded from
    // what feeds these ratios. If a similar incident is ever confirmed
    // again, add it here the same way rather than widening this window's
    // bounds to guess at it.
    const CORRUPTED_EQUITY_WINDOWS: { accountId: number; brokerKind: string; from: Date; to: Date }[] = [
      { accountId: 1, brokerKind: "browser_control", from: new Date("2026-07-20T14:26:23.602Z"), to: new Date("2026-07-20T16:13:37.133Z") },
    ];
    const activeExclusion = CORRUPTED_EQUITY_WINDOWS.find((w) => w.accountId === account.id && brokerKindsToQuery.includes(w.brokerKind));

    const equityRowsDesc = await prisma.equityCurvePoint.findMany({
      where: {
        accountId: account.id,
        brokerKind: { in: brokerKindsToQuery },
        ...(activeExclusion ? { OR: [{ time: { lte: activeExclusion.from } }, { time: { gte: activeExclusion.to } }] } : {}),
      },
      orderBy: { time: "desc" },
      take: 5000,
    });
    const portfolioStats = computePortfolioStats(equityRowsDesc.map((r) => Number(r.equity)).reverse());

    // byStrategy is keyed by (strategyId, symbol), not just strategyId -- a strategy blended
    // across every instrument hides exactly the thing this table exists to answer ("which signal
    // is better to trade"), since the same strategyId can perform very differently per instrument
    // (2026-09-04 operator request: "these win rates need to be by signal nq es and gc not just
    // all in one"). Each strategy also gets an "all" pseudo-symbol row, the same blended figure
    // this table used to show alone, so the previous overall-ranking view isn't lost -- just no
    // longer the only one.
    const byStrategy = new Map<string, Map<string, number[]>>();
    const byRegime = new Map<string, number[]>();
    for (const t of closed) {
      const pnl = Number(t.pnl ?? 0);
      const bySymbol = byStrategy.get(t.strategyId) ?? new Map<string, number[]>();
      bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), pnl]);
      bySymbol.set("all", [...(bySymbol.get("all") ?? []), pnl]);
      byStrategy.set(t.strategyId, bySymbol);
      const key = `${t.regimeTrendAtEntry}/${t.regimeVolAtEntry}`;
      byRegime.set(key, [...(byRegime.get(key) ?? []), pnl]);
    }

    const summarize = (v: number[]) => ({ tradeCount: v.length, totalPnl: v.reduce((a, b) => a + b, 0), winRate: v.length ? v.filter((x) => x > 0).length / v.length : 0 });
    const bucketSummary = (buckets: Map<string, number[]>) => Object.fromEntries([...buckets.entries()].map(([k, v]) => [k, summarize(v)]));

    return {
      tradeStats,
      portfolioStats,
      byStrategy: Object.fromEntries([...byStrategy.entries()].map(([strategyId, bySymbol]) => [strategyId, bucketSummary(bySymbol)])),
      byRegime: bucketSummary(byRegime),
    };
}

export async function performanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { accountId?: string } }>("/api/performance/summary", async (request) => {
    return getPerformanceSummary(request.query.accountId ? Number(request.query.accountId) : undefined);
  });
}
