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

// TopstepX's funded-account starting balance depends on account *type*, not
// just its size tier -- confirmed live 2026-07-21 by the operator's own
// three real accounts: "$50K EXPRESS" starts at $0 (Express accounts fund
// differently -- there's no evaluation-phase balance to inherit), while
// "50K DLL COMBINE" / "100K DLL COMBINE" start at their full size tier
// ($50,000 / $100,000). Falls back to $50,000 for an unrecognized name shape
// rather than guessing at $0, since that's the more common case among
// existing accounts and was the previous fixed default.
export function inferStartingBalance(accountName: string): string {
  if (/express/i.test(accountName)) return "0";
  const sizeMatch = accountName.match(/(\d+)\s*K/i);
  if (sizeMatch) return String(Number(sizeMatch[1]) * 1000);
  return "50000";
}

// Separate from ensureDefaultAccount -- trades and risk-limit tracking
// deliberately still use the single shared "default" account (2026-07-21
// scoping decision), so this exists purely to give each real TopstepX
// account (identified by its scraped brokerAccountId, e.g.
// "50KTC-V2-DLL-170199-51281387") its own row for equity-curve history,
// instead of blending every account an operator switches through in the
// browser into one curve. No RiskLimit row is created for these -- nothing
// reads risk limits against them, only equity_curve rows key off their id.
export async function ensureAccountForBrokerId(brokerAccountId: string, name: string): Promise<Account> {
  const existing = await prisma.account.findFirst({ where: { brokerAccountId } });
  if (existing) return existing;

  return prisma.account.create({
    data: { name, brokerAccountId, startingBalance: inferStartingBalance(name), isActive: true },
  });
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
