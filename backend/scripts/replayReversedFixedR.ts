// One-off what-if analysis (2026-08-27, operator request): take every signal
// the REAL decision pipeline would have approved and executed (decideOnBar's
// plan.approved, run unmodified via runReplay -- same real pipeline, real
// stop/target, real sizing), then ask a separate question on top: what if,
// instead of taking that trade, we took the OPPOSITE side at the same entry
// (next bar's open, same fill convention as harness.ts) with a fixed 2pt
// take-profit / 6pt stop-loss instead of the plan's own ATR/structure stop?
//
// Deliberately NOT a change to decisionCore.ts, harness.ts, or risk/stops.ts:
// per .claude/rules/replay-harness.md, the real decision pipeline stays
// untouched and unbranched. This script only reads runReplay's OUTPUT
// (result.decisions) and re-simulates a hypothetical alternate trade forward
// over the same historical bars, using the same stop-wins-same-bar-tie
// convention harness.ts / analytics/outcomeSimulation.ts already use, so the
// number is comparable to the real replay's own metrics.
//
// Simplification, stated explicitly rather than hidden: each hypothetical
// reversed trade is resolved in isolation (walked forward to its own
// stop/target hit, independent of whether a later approved signal arrives
// before this one would have closed). This is NOT a portfolio simulation --
// it does not enforce "one hypothetical position open at a time." It answers
// "in aggregate, across every real approved signal, what would the reversed
// 2/6 trade have done," not "what would an account actually running this
// have done." Good enough for a win-rate/expectancy read; say so in the
// summary.
//
// Usage: npx tsx scripts/replayReversedFixedR.ts [lookbackDays]
import { Decimal } from "decimal.js";
import { prisma } from "../src/db/client.js";
import { runReplay } from "../src/replay/harness.js";
import { ReplayDecisionContext } from "../src/replay/replayDecisionContext.js";
import { getInstrument } from "../src/marketData/instruments.js";
import { DEFAULT_SLIPPAGE_TICKS } from "../src/brokers/simulatedBroker.js";
import type { ReplayConfig } from "../src/replay/types.js";
import type { RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { OhlcBar } from "../src/regime/indicators.js";

const SYMBOLS = ["ES", "NQ"];
const LOOKBACK_DAYS = process.argv[2] ? Number(process.argv[2]) : 7;

// The sweep knobs this script exists to test -- fixed point distances,
// independent of ATR/structure, applied to the REVERSED side of every
// approved signal.
const FIXED_TAKE_PROFIT_POINTS = 2;
const FIXED_STOP_LOSS_POINTS = 6;
const COMMISSION_PER_CONTRACT_PER_SIDE = 0; // see ReplayConfig's own comment -- understates real P&L until a real rate is supplied

interface HypotheticalTrade {
  symbol: string;
  side: "long" | "short";
  entryTime: Date;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  exitTime: Date | null;
  exitPrice: number | null;
  exitReason: "stop" | "target" | "unresolved";
  rMultiple: number;
  pnl: number;
}

async function loadBars(symbol: string): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({ where: { symbol }, orderBy: { time: "asc" } });
  return rows.map((r) => ({
    time: r.time, open: r.open.toNumber(), high: r.high.toNumber(), low: r.low.toNumber(), close: r.close.toNumber(), volume: r.volume.toNumber(),
  }));
}

/**
 * Walks forward from entryIndex+1 looking for the first bar that touches
 * either the fixed stop or fixed target. Same house rule as
 * harness.ts's resolveAgainstBar: a bar whose range could have hit both
 * resolves to the STOP (pessimistic, the only defensible choice without tick
 * data -- see analytics/outcomeSimulation.ts).
 */
function resolveFixedRTrade(
  bars: OhlcBar[],
  entryIndex: number,
  side: "long" | "short",
  entryPrice: Decimal,
  stopPrice: Decimal,
  takeProfitPrice: Decimal,
  pointValue: Decimal,
  tickSize: Decimal,
): { exitTime: Date | null; exitPrice: Decimal | null; reason: "stop" | "target" | "unresolved" } {
  for (let i = entryIndex + 1; i < bars.length; i++) {
    const bar = bars[i]!;
    const high = new Decimal(bar.high);
    const low = new Decimal(bar.low);

    const hitStop = side === "long" ? low.lte(stopPrice) : high.gte(stopPrice);
    if (hitStop) return { exitTime: bar.time, exitPrice: stopPrice, reason: "stop" };

    const hitTarget = side === "long" ? high.gte(takeProfitPrice) : low.lte(takeProfitPrice);
    if (hitTarget) return { exitTime: bar.time, exitPrice: takeProfitPrice, reason: "target" };
  }
  return { exitTime: null, exitPrice: null, reason: "unresolved" };
}

function realizedPnl(
  side: "long" | "short",
  entryPrice: Decimal,
  exitPrice: Decimal,
  pointValue: Decimal,
  tickSize: Decimal,
): number {
  const move = side === "long" ? exitPrice.minus(entryPrice) : entryPrice.minus(exitPrice);
  const gross = move.times(pointValue);
  const slippageCost = tickSize.times(DEFAULT_SLIPPAGE_TICKS).times(2).times(pointValue);
  const commissionCost = new Decimal(COMMISSION_PER_CONTRACT_PER_SIDE).times(2);
  return gross.minus(slippageCost).minus(commissionCost).toNumber();
}

function summarize(trades: HypotheticalTrade[]) {
  const resolved = trades.filter((t) => t.exitReason !== "unresolved");
  const n = resolved.length;
  if (n === 0) return { trades: 0 };
  const rs = resolved.map((t) => t.rMultiple);
  const wins = rs.filter((r) => r > 0);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stdev = (xs: number[]) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  };
  return {
    trades: n,
    unresolved: trades.length - n,
    winRate: wins.length / n,
    expectancyR: mean(rs),
    expectancyStdErr: n > 1 ? stdev(rs) / Math.sqrt(n) : NaN,
    totalR: rs.reduce((a, b) => a + b, 0),
    netPnl: resolved.reduce((a, t) => a + t.pnl, 0),
  };
}

async function main() {
  console.log("loading historical bars...");
  const barsBySymbol = new Map<string, OhlcBar[]>();
  for (const symbol of SYMBOLS) {
    const bars = await loadBars(symbol);
    barsBySymbol.set(symbol, bars);
    console.log(`  ${symbol}: ${bars.length} bars, ${bars[0]?.time.toISOString()} -> ${bars.at(-1)?.time.toISOString()}`);
  }

  const allTimes = [...barsBySymbol.values()].flat().map((b) => b.time.getTime());
  const to = new Date(Math.max(...allTimes));
  const from = new Date(Math.max(Math.min(...allTimes), to.getTime() - LOOKBACK_DAYS * 86_400_000));

  const limits: RiskLimitsConfig = {
    perTradeRiskPct: new Decimal("0.5"),
    maxDailyLossPct: new Decimal("3.0"),
    maxTrailingDrawdownPct: new Decimal("6.0"),
    maxConsecutiveLosses: 3,
    maxDailyTrades: 8,
    maxPositionSize: 3,
    perTradeRiskDollars: null,
    perTradeProfitDollars: null,
    maxDailyLossDollars: null,
  };

  const config: ReplayConfig = {
    symbols: SYMBOLS,
    from,
    to,
    startingEquity: 50_000,
    warmupBars: 300,
    commissionPerContractPerSide: 0,
  };

  const ctx = new ReplayDecisionContext(barsBySymbol, config.startingEquity, limits);

  console.log(`running REAL replay to find approved signals: ${from.toISOString()} -> ${to.toISOString()}...`);
  const started = Date.now();
  const result = await runReplay(config, ctx, barsBySymbol);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  real trades: ${result.trades.length}, real metrics:`, result.metrics);

  const allHypothetical: HypotheticalTrade[] = [];
  const bySymbol = new Map<string, HypotheticalTrade[]>();

  for (const symbol of SYMBOLS) {
    const instrument = getInstrument(symbol);
    const bars = barsBySymbol.get(symbol)!;
    const approved = result.decisions
      .filter((d) => d.symbol === symbol && d.plan?.approved && d.signal)
      .sort((a, b) => a.barTime.getTime() - b.barTime.getTime());

    const symbolTrades: HypotheticalTrade[] = [];

    for (const decision of approved) {
      const barIndex = bars.findIndex((b) => b.time.getTime() === decision.barTime.getTime());
      if (barIndex < 0 || barIndex + 1 >= bars.length) continue;
      const entryBar = bars[barIndex + 1]!; // same "fills at NEXT bar's open" convention as harness.ts
      const entryPrice = new Decimal(entryBar.open);

      const reversedSide: "long" | "short" = decision.signal!.side === "long" ? "short" : "long";
      const stopPrice = reversedSide === "long"
        ? entryPrice.minus(FIXED_STOP_LOSS_POINTS)
        : entryPrice.plus(FIXED_STOP_LOSS_POINTS);
      const takeProfitPrice = reversedSide === "long"
        ? entryPrice.plus(FIXED_TAKE_PROFIT_POINTS)
        : entryPrice.minus(FIXED_TAKE_PROFIT_POINTS);

      const resolved = resolveFixedRTrade(
        bars, barIndex + 1, reversedSide, entryPrice, stopPrice, takeProfitPrice,
        instrument.pointValue, instrument.tickSize,
      );

      const rMultiple = resolved.exitPrice
        ? (reversedSide === "long"
            ? resolved.exitPrice.minus(entryPrice)
            : entryPrice.minus(resolved.exitPrice)
          ).dividedBy(FIXED_STOP_LOSS_POINTS).toNumber()
        : 0;

      const pnl = resolved.exitPrice
        ? realizedPnl(reversedSide, entryPrice, resolved.exitPrice, instrument.pointValue, instrument.tickSize)
        : 0;

      symbolTrades.push({
        symbol,
        side: reversedSide,
        entryTime: entryBar.time,
        entryPrice: entryPrice.toNumber(),
        stopPrice: stopPrice.toNumber(),
        takeProfitPrice: takeProfitPrice.toNumber(),
        exitTime: resolved.exitTime,
        exitPrice: resolved.exitPrice?.toNumber() ?? null,
        exitReason: resolved.reason,
        rMultiple,
        pnl,
      });
    }

    bySymbol.set(symbol, symbolTrades);
    allHypothetical.push(...symbolTrades);
    console.log(`  ${symbol}: ${approved.length} approved real signals -> ${symbolTrades.length} hypothetical reversed trades`, summarize(symbolTrades));
  }

  console.log("\n=== Combined: reversed side, fixed 2pt TP / 6pt SL ===");
  console.log(summarize(allHypothetical));
  console.log(
    "\nNote: this is NOT a portfolio simulation (no 'one hypothetical position at a time' " +
    "enforcement) and commission is 0 (understates real cost) -- see this script's header comment.",
  );
  console.log("Break-even win rate at this 2:6 ratio (before costs) is 75% -- expectancy = winRate*(2/6) - (1-winRate).");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
