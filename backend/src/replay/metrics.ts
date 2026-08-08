/**
 * Replay metrics — the honest scorecard.
 *
 * Ported in spirit from Vibe-Trading's backtest/metrics.py, but reframed for
 * a bracket-order, single-instrument system: R-multiple distribution matters
 * more than Sharpe here, and expectancy per trade is what actually decides
 * whether a gate change was an improvement.
 *
 * Deliberately includes the unflattering ones. A harness that only reports
 * win rate will talk you into every change you already wanted to make.
 */
import type { ReplayTrade } from "./types.js";

const MINUTES_PER_TRADING_YEAR = 252 * 6.5 * 60;

export function computeReplayMetrics(
  trades: ReplayTrade[],
  equityCurve: Array<{ time: Date; equity: number }>,
  startingEquity: number,
): Record<string, number> {
  const resolved = trades.filter((t) => t.exitReason !== "unresolved");
  const n = resolved.length;
  if (n === 0) return { trades: 0 };

  const rs = resolved.map((t) => t.rMultiple);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);

  const expectancyR = mean(rs);
  const winRate = wins.length / n;
  const avgWinR = wins.length ? mean(wins) : 0;
  const avgLossR = losses.length ? mean(losses) : 0;
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1]!.equity : startingEquity;
  const { maxDrawdown, maxDrawdownPct } = drawdown(equityCurve, startingEquity);

  return {
    trades: n,
    winRate,
    expectancyR,
    // Expectancy is the number to optimize. Win rate alone is a trap: your
    // stop/target geometry means a 40% win rate at 2R beats a 60% win rate at
    // 0.8R, and gate changes routinely trade one for the other.
    avgWinR,
    avgLossR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    totalR: sum(rs),
    netPnl: finalEquity - startingEquity,
    maxDrawdown,
    maxDrawdownPct,
    // Standard error on expectancy. Report it next to expectancy ALWAYS.
    // With 40 trades a 0.15R "improvement" is indistinguishable from noise,
    // and this is the number that tells you so before you ship the change.
    expectancyStdErr: n > 1 ? stdev(rs) / Math.sqrt(n) : NaN,
    sharpeApprox: sharpe(equityCurve),
    longestLosingStreak: longestStreak(rs, (r) => r <= 0),
    // Fraction that never resolved inside the replay window — high values
    // mean your target/stop geometry rarely completes, which silently biases
    // every other metric here toward the trades that happened to finish.
    unresolvedRate: (trades.length - n) / Math.max(trades.length, 1),
  };
}

function drawdown(curve: Array<{ equity: number }>, start: number) {
  let peak = start;
  let maxDrawdown = 0;
  for (const point of curve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return { maxDrawdown, maxDrawdownPct: peak > 0 ? maxDrawdown / peak : 0 };
}

function sharpe(curve: Array<{ time: Date; equity: number }>): number {
  if (curve.length < 3) return NaN;
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!.equity;
    if (prev <= 0) continue;
    returns.push((curve[i]!.equity - prev) / prev);
  }
  if (returns.length < 2) return NaN;
  const sd = stdev(returns);
  if (sd === 0) return NaN;
  // Trade-clock, not wall-clock. Annualizing per-trade returns as if they were
  // daily is the classic way a bot backtest reports a Sharpe of 9.
  const barsPerYear = MINUTES_PER_TRADING_YEAR / 5; // 5-minute bars
  return (mean(returns) / sd) * Math.sqrt(barsPerYear / Math.max(returns.length, 1));
}

function longestStreak(values: number[], predicate: (v: number) => boolean): number {
  let best = 0;
  let current = 0;
  for (const v of values) {
    current = predicate(v) ? current + 1 : 0;
    if (current > best) best = current;
  }
  return best;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;
const stdev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
};
