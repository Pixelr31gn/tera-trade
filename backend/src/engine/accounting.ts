/** Account equity, drawdown, and streak bookkeeping used to feed the risk engine. */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import type { Account } from "@prisma/client";
import { AccountSource, BrokerKind, getSettings, TradingMode } from "../core/config.js";
import type { AccountRiskState } from "../risk/circuitBreakers.js";
import { getLatestBrowserAccountSnapshot } from "./liveAccountOverride.js";
import { getSystemState } from "../execution/mode.js";

export async function computeOpenUnrealizedPnl(accountId: number, lastPrices: Map<string, Decimal>, brokerKind?: string): Promise<Decimal> {
  const openTrades = await prisma.trade.findMany({ where: { accountId, status: "open", ...(brokerKind ? { brokerKind } : {}) } });
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

export async function computeAccountEquity(
  account: Account,
  lastPrices: Map<string, Decimal>,
  brokerKindOverride?: BrokerKind
): Promise<Decimal> {
  const settings = getSettings();
  // The scraped balance is the REAL account's equity -- only meaningful
  // while actually trading LIVE. Previously gated on `account.name !==
  // "paper"`, which assumed a separate account row per mode that never
  // actually existed in this schema (there is exactly one non-paper account,
  // always named "default", shared by both paper and live trades -- see
  // Trade.brokerKind for how a given trade's own broker is tracked instead).
  // That condition was therefore always true, so switching to PAPER mode
  // never stopped showing the real live balance (2026-07-15 operator
  // report). Now keyed off the actual current system mode: paper and
  // analysis-only both compute their own equity purely from this account's
  // own trade history below, exactly like a fresh paper account simulating
  // from its starting balance should.
  //
  // brokerKindOverride (added for the Tradesea second-broker integration)
  // lets a caller explicitly say "compute equity for THIS broker kind,"
  // bypassing the single global settings.brokerKind/systemState.mode this
  // function otherwise infers from. It is the caller's assertion that this
  // broker is genuinely live right now (loop.ts only passes it once
  // Tradesea's own independent live-enable gate has already cleared) -- this
  // function doesn't re-check that itself, same as it never re-derives
  // liveTradingConfirmed for the primary path either. Omitted, behavior is
  // byte-identical to before this parameter existed.
  const brokerKind = brokerKindOverride ?? ((await currentBrokerKind()) as BrokerKind);
  const readsBrowserSnapshot = brokerKindOverride
    ? brokerKind !== BrokerKind.SIMULATED
    : settings.accountSource === AccountSource.BROWSER && brokerKind !== BrokerKind.SIMULATED;
  if (readsBrowserSnapshot) {
    const snapshot = getLatestBrowserAccountSnapshot(brokerKind);
    const scraped = snapshot?.equity ?? snapshot?.balance;
    if (scraped !== null && scraped !== undefined) return new Decimal(scraped);
    // No snapshot read yet (watcher hasn't polled, or the page didn't match any label) --
    // fall through to the simulated calculation rather than block on missing data.
  }

  // Reaching here means the account's equity is being computed for
  // PAPER/ANALYSIS_ONLY purposes (LIVE returned early above) -- paper and
  // live trades share this same account row (there's only ever one), so
  // without this filter a paper balance would silently include real trade
  // P&L too. Scoped to exactly the simulated broker's own trades, so this
  // reflects only what the strategy itself has done in paper, never live.
  // Summed in Postgres rather than pulling every closed trade this account has
  // ever had into Node and reducing in JS -- this is called on every price
  // tick and every new bar (the hottest paths in the app), so its cost must
  // stay flat as trade history grows rather than scaling with it. Unlike the
  // TTL-cached stats in engine/*Cache.ts, realized P&L feeds real risk/
  // drawdown checks and has zero acceptable staleness, so a cache isn't the
  // right fix here -- an exact DB-side aggregate is.
  //
  // scopedBrokerKind stays hardcoded to SIMULATED for the no-override path
  // (byte-identical to before), but uses the resolved brokerKind for an
  // override (e.g. Tradesea with no snapshot read yet) so its fallback
  // reflects that venue's own trade history instead of always reading zero.
  const scopedBrokerKind = brokerKindOverride ? brokerKind : BrokerKind.SIMULATED;
  const realizedAgg = await prisma.trade.aggregate({
    where: { accountId: account.id, status: "closed", brokerKind: scopedBrokerKind },
    _sum: { pnl: true },
  });
  const realized = new Decimal(realizedAgg._sum.pnl?.toString() ?? "0");
  const unrealized = await computeOpenUnrealizedPnl(account.id, lastPrices, scopedBrokerKind);
  return new Decimal(account.startingBalance.toString()).plus(realized).plus(unrealized);
}

export async function recordEquityPoint(accountId: number, equity: Decimal, balance: Decimal, at: Date, brokerKind: string): Promise<void> {
  await prisma.equityCurvePoint.upsert({
    where: { time_accountId_brokerKind: { time: at, accountId, brokerKind } },
    update: { equity: equity.toString(), balance: balance.toString() },
    create: { time: at, accountId, brokerKind, equity: equity.toString(), balance: balance.toString() },
  });
}

/**
 * Which broker's trade/equity history is relevant right now -- paper and
 * live share one account row, so every risk/equity query that reads trade
 * or equity-curve history must scope to this or it silently blends live and
 * paper together (2026-07-15: a paper losing streak could trip LIVE's
 * maxConsecutiveLosses breaker, or a live peak equity could corrupt paper's
 * trailing-drawdown calc, and vice versa). Exported for the same reason
 * api/routes/accounts.ts's equity-curve endpoint needs it -- the dashboard's
 * equity chart was showing a blended live+paper curve for the same reason.
 */
export async function currentBrokerKind(): Promise<string> {
  const settings = getSettings();
  const systemState = await getSystemState();
  return systemState.mode === TradingMode.LIVE ? settings.brokerKind : BrokerKind.SIMULATED;
}

/**
 * Which brokerKind a GIVEN account's trade/equity rows are actually scoped
 * under -- currentBrokerKind() alone is only correct for the primary
 * ("default"/"paper") accounts, whose brokerKind genuinely varies with the
 * current global mode (see onPriceTick's own equity recording, which calls
 * brokerKindForMode(mode) -- the same account id can carry both
 * "browser_control" rows from a past LIVE stretch and "simulated" rows from
 * a past PAPER stretch). Tradesea's account is different: every row it
 * writes uses the fixed BrokerKind.TRADESEA_BROWSER_CONTROL constant,
 * completely independent of TopstepX's mode (see
 * TradingEngine.recordTradeseaEquitySnapshot) -- filtering it by the global
 * currentBrokerKind() would silently return nothing. Added for the
 * multi-account API widening (2026-08-28) -- every other account continues
 * to resolve via currentBrokerKind(), unchanged.
 */
export async function brokerKindForAccount(account: Account): Promise<string> {
  if (account.name === "tradesea") return BrokerKind.TRADESEA_BROWSER_CONTROL;
  return currentBrokerKind();
}

export async function computeAccountRiskState(
  account: Account,
  currentEquity: Decimal,
  brokerKindOverride?: BrokerKind
): Promise<AccountRiskState> {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // See computeAccountEquity's own comment on brokerKindOverride -- same
  // meaning here: omitted, byte-identical to before this parameter existed.
  const brokerKind = brokerKindOverride ?? (await currentBrokerKind());

  const peakRow = await prisma.equityCurvePoint.aggregate({ where: { accountId: account.id, brokerKind }, _max: { equity: true } });
  let peakEquity = peakRow._max.equity ? new Decimal(peakRow._max.equity.toString()) : currentEquity;
  peakEquity = Decimal.max(peakEquity, currentEquity);

  const firstToday = await prisma.equityCurvePoint.findFirst({
    where: { accountId: account.id, brokerKind, time: { gte: todayStart } },
    orderBy: { time: "asc" },
  });
  const dailyStartingEquity = firstToday ? new Decimal(firstToday.equity.toString()) : currentEquity;

  // Scoped to trades closed today (same UTC day boundary as tradesToday
  // below) -- operator request, 2026-07-27: a losing streak used to persist
  // across days indefinitely, since the circuit breaker it feeds blocks all
  // new entries and a win is the only thing that clears it, which meant a
  // bad session could permanently wedge the account with no way to recover
  // without a manual risk_limits edit. Scoping to today gives yesterday's
  // streak a hard reset at UTC midnight, same as the daily-trade-count and
  // daily-loss-% breakers already get.
  const recentClosed = await prisma.trade.findMany({
    where: { accountId: account.id, status: "closed", brokerKind, exitTime: { gte: todayStart } },
    orderBy: { exitTime: "desc" },
    take: 50,
    select: { pnl: true },
  });
  let consecutiveLosses = 0;
  for (const t of recentClosed) {
    if (t.pnl !== null && Number(t.pnl) < 0) consecutiveLosses++;
    else break;
  }

  const tradesToday = await prisma.trade.count({ where: { accountId: account.id, brokerKind, entryTime: { gte: todayStart } } });

  return { currentEquity, peakEquity, dailyStartingEquity, consecutiveLosses, tradesToday };
}
