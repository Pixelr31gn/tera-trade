/** Account equity, drawdown, and streak bookkeeping used to feed the risk engine. */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import type { Account } from "@prisma/client";
import type { AccountRiskState } from "../risk/circuitBreakers.js";

export async function computeOpenUnrealizedPnl(accountId: number, lastPrices: Map<string, Decimal>): Promise<Decimal> {
  const openTrades = await prisma.trade.findMany({ where: { accountId, status: "open" } });
  if (openTrades.length === 0) return new Decimal(0);

  const instruments = await prisma.instrument.findMany();
  const pointValues = new Map(instruments.map((i) => [i.symbol, new Decimal(i.pointValue.toString())]));

  let total = new Decimal(0);
  for (const trade of openTrades) {
    const lastPrice = lastPrices.get(trade.symbol);
    if (!lastPrice) continue;
    const pointValue = pointValues.get(trade.symbol) ?? new Decimal(1);
    const direction = trade.side === "long" ? 1 : -1;
    total = total.plus(lastPrice.minus(trade.entryPrice.toString()).times(direction).times(pointValue).times(trade.quantity));
  }
  return total;
}

export async function computeAccountEquity(account: Account, lastPrices: Map<string, Decimal>): Promise<Decimal> {
  const closedTrades = await prisma.trade.findMany({ where: { accountId: account.id, status: "closed" }, select: { pnl: true } });
  const realized = closedTrades.reduce((acc, t) => acc.plus(t.pnl?.toString() ?? "0"), new Decimal(0));
  const unrealized = await computeOpenUnrealizedPnl(account.id, lastPrices);
  return new Decimal(account.startingBalance.toString()).plus(realized).plus(unrealized);
}

export async function recordEquityPoint(accountId: number, equity: Decimal, balance: Decimal, at: Date): Promise<void> {
  await prisma.equityCurvePoint.upsert({
    where: { time_accountId: { time: at, accountId } },
    update: { equity: equity.toString(), balance: balance.toString() },
    create: { time: at, accountId, equity: equity.toString(), balance: balance.toString() },
  });
}

export async function computeAccountRiskState(account: Account, currentEquity: Decimal): Promise<AccountRiskState> {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const peakRow = await prisma.equityCurvePoint.aggregate({ where: { accountId: account.id }, _max: { equity: true } });
  let peakEquity = peakRow._max.equity ? new Decimal(peakRow._max.equity.toString()) : currentEquity;
  peakEquity = Decimal.max(peakEquity, currentEquity);

  const firstToday = await prisma.equityCurvePoint.findFirst({
    where: { accountId: account.id, time: { gte: todayStart } },
    orderBy: { time: "asc" },
  });
  const dailyStartingEquity = firstToday ? new Decimal(firstToday.equity.toString()) : currentEquity;

  const recentClosed = await prisma.trade.findMany({
    where: { accountId: account.id, status: "closed" },
    orderBy: { exitTime: "desc" },
    take: 50,
    select: { pnl: true },
  });
  let consecutiveLosses = 0;
  for (const t of recentClosed) {
    if (t.pnl !== null && Number(t.pnl) < 0) consecutiveLosses++;
    else break;
  }

  const tradesToday = await prisma.trade.count({ where: { accountId: account.id, entryTime: { gte: todayStart } } });

  return { currentEquity, peakEquity, dailyStartingEquity, consecutiveLosses, tradesToday };
}
