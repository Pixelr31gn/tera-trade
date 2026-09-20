/** One-time setup helpers: default account/risk-limits row, bar history loading. */
import { prisma } from "../db/client.js";
import { BrokerKind, getSettings } from "../core/config.js";
import type { Account } from "@prisma/client";
import type { OhlcBar } from "../regime/indicators.js";

// Paper (simulated broker) and real (browser_control/projectx/tradesea)
// trading must never share an account row -- otherwise a paper trade's P&L
// lands on the same equity curve and "open positions" list as a real
// position, and simulated fills could look like they're happening on a real
// account. Keying the account by brokerKind keeps them fully separate: paper
// starts fresh at $0 and only ever contains trades the simulated broker
// actually filled; each real broker kind keeps its own funded-account equity
// curve untouched by the others.
export async function ensureAccountForBrokerKind(brokerKind: BrokerKind): Promise<Account> {
  const settings = getSettings();
  const isPaper = brokerKind === BrokerKind.SIMULATED;
  const isTradesea = brokerKind === BrokerKind.TRADESEA_BROWSER_CONTROL;
  const name = isPaper ? "paper" : isTradesea ? "tradesea" : "default";

  const existing = await prisma.account.findFirst({ where: { name } });
  if (existing) return existing;

  const account = await prisma.account.create({
    data: { name, startingBalance: isPaper ? "0" : "50000", isActive: true },
  });

  // Tradesea's risk limits mirror TopstepX's DEFAULT_* values unless a
  // dedicated TRADESEA_DEFAULT_* override is set (operator's explicit
  // choice: same risk posture on both venues even though the underlying
  // account balances differ -- see docs/BUILD_HISTORY.md's Tradesea entry).
  const perTradeRiskPct = (isTradesea ? settings.tradeseaDefaultPerTradeRiskPct : undefined) ?? settings.defaultPerTradeRiskPct;
  const maxDailyLossPct = (isTradesea ? settings.tradeseaDefaultMaxDailyLossPct : undefined) ?? settings.defaultMaxDailyLossPct;
  const maxTrailingDrawdownPct =
    (isTradesea ? settings.tradeseaDefaultMaxTrailingDrawdownPct : undefined) ?? settings.defaultMaxTrailingDrawdownPct;
  const maxPositionSize = (isTradesea ? settings.tradeseaDefaultMaxPositionSize : undefined) ?? settings.defaultMaxPositionSize;
  const maxConsecutiveLosses = (isTradesea ? settings.tradeseaMaxConsecutiveLosses : undefined) ?? settings.maxConsecutiveLosses;
  const maxDailyTrades = (isTradesea ? settings.tradeseaMaxDailyTrades : undefined) ?? settings.maxDailyTrades;

  await prisma.riskLimit.create({
    data: {
      accountId: account.id,
      perTradeRiskPct: perTradeRiskPct.toString(),
      maxDailyLossPct: maxDailyLossPct.toString(),
      maxTrailingDrawdownPct: maxTrailingDrawdownPct.toString(),
      maxPositionSize,
      maxConsecutiveLosses,
      maxDailyTrades,
      perTradeRiskDollars: settings.defaultPerTradeRiskDollars?.toString(),
      perTradeProfitDollars: settings.defaultPerTradeProfitDollars?.toString(),
      maxDailyLossDollars: settings.defaultMaxDailyLossDollars?.toString(),
    },
  });

  return account;
}

export async function ensureDefaultAccount(): Promise<Account> {
  return ensureAccountForBrokerKind(getSettings().brokerKind);
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
