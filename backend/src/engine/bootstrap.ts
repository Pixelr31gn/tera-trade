/** One-time setup helpers: default account/risk-limits row, bar history loading. */
import { prisma } from "../db/client.js";
import { BrokerKind, getSettings } from "../core/config.js";
import type { Account } from "@prisma/client";
import type { OhlcBar } from "../regime/indicators.js";

// Paper (simulated broker) and real (browser_control/projectx) trading must
// never share an account row -- otherwise a paper trade's P&L lands on the
// same equity curve and "open positions" list as a real Topstep position,
// and simulated fills could look like they're happening on the real account.
// Keying the account by brokerKind keeps them fully separate: paper starts
// fresh at $0 and only ever contains trades the simulated broker actually
// filled, real keeps its own $50k-funded-account equity curve untouched.
export async function ensureDefaultAccount(): Promise<Account> {
  const settings = getSettings();
  const isPaper = settings.brokerKind === BrokerKind.SIMULATED;
  const name = isPaper ? "paper" : "default";

  const existing = await prisma.account.findFirst({ where: { name } });
  if (existing) return existing;

  const account = await prisma.account.create({
    data: { name, startingBalance: isPaper ? "0" : "50000", isActive: true },
  });

  await prisma.riskLimit.create({
    data: {
      accountId: account.id,
      perTradeRiskPct: settings.defaultPerTradeRiskPct.toString(),
      maxDailyLossPct: settings.defaultMaxDailyLossPct.toString(),
      maxTrailingDrawdownPct: settings.defaultMaxTrailingDrawdownPct.toString(),
      maxPositionSize: settings.defaultMaxPositionSize,
      maxConsecutiveLosses: settings.maxConsecutiveLosses,
      maxDailyTrades: settings.maxDailyTrades,
      perTradeRiskDollars: settings.defaultPerTradeRiskDollars?.toString(),
      perTradeProfitDollars: settings.defaultPerTradeProfitDollars?.toString(),
      maxDailyLossDollars: settings.defaultMaxDailyLossDollars?.toString(),
    },
  });

  return account;
}

export async function loadRecentBars(symbol: string, limit = 300): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({
    where: { symbol },
    orderBy: { time: "desc" },
    take: limit,
  });
  return rows
    .reverse()
    .map((r) => ({
      time: r.time,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
}
