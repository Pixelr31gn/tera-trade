/** One-time setup helpers: default account/risk-limits row, bar history loading. */
import { prisma } from "../db/client.js";
import { getSettings } from "../core/config.js";
import type { Account } from "@prisma/client";
import type { OhlcBar } from "../regime/indicators.js";

export async function ensureDefaultAccount(): Promise<Account> {
  const existing = await prisma.account.findFirst({ where: { name: "default" } });
  if (existing) return existing;

  const settings = getSettings();
  const account = await prisma.account.create({ data: { name: "default", startingBalance: "50000", isActive: true } });

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
