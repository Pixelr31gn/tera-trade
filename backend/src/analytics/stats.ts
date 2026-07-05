/**
 * Professional-grade trade & portfolio statistics.
 *
 * Pure functions (numbers in, plain objects out) -- trivially unit-testable
 * against synthetic trade sets and reusable from both the API layer and the
 * offline scoring-model training pipeline.
 */
const TRADING_PERIODS_PER_YEAR = 252;

export interface TradeStats {
  tradeCount: number;
  winRate: number;
  expectedValue: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  avgMae: number | null;
  avgMfe: number | null;
  largestWin: number;
  largestLoss: number;
}

export interface PortfolioStats {
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationDays: number;
  volatilityAnnualized: number | null;
  cagr: number | null;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeTradeStats(trades: Array<{ pnl: number; mae?: number | null; mfe?: number | null }>): TradeStats {
  if (trades.length === 0) {
    return { tradeCount: 0, winRate: 0, expectedValue: 0, profitFactor: null, avgWin: 0, avgLoss: 0, avgMae: null, avgMfe: null, largestWin: 0, largestLoss: 0 };
  }

  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);

  const maes = trades.map((t) => t.mae).filter((v): v is number => v != null);
  const mfes = trades.map((t) => t.mfe).filter((v): v is number => v != null);

  return {
    tradeCount: pnls.length,
    winRate: wins.length / pnls.length,
    expectedValue: mean(pnls),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? mean(losses) : 0,
    avgMae: maes.length ? mean(maes) : null,
    avgMfe: mfes.length ? mean(mfes) : null,
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? Math.min(...losses) : 0,
  };
}

/** Returns [maxDrawdownPct (positive fraction), longest underwater duration in periods]. */
export function maxDrawdown(equity: number[]): [number, number] {
  if (equity.length === 0) return [0, 0];
  let runningMax = equity[0]!;
  let maxDd = 0;
  let longest = 0;
  let current = 0;

  for (const value of equity) {
    runningMax = Math.max(runningMax, value);
    const dd = (value - runningMax) / runningMax;
    maxDd = Math.max(maxDd, -dd);
    if (dd < 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return [maxDd, longest];
}

function pctChange(equity: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    returns.push((equity[i]! - equity[i - 1]!) / equity[i - 1]!);
  }
  return returns;
}

export function realizedVolatility(returns: number[], annualize = true): number | null {
  if (returns.length < 2) return null;
  const vol = stddev(returns);
  if (Number.isNaN(vol)) return null;
  return annualize ? vol * Math.sqrt(TRADING_PERIODS_PER_YEAR) : vol;
}

export function sharpeRatio(returns: number[], riskFreeRate = 0, annualize = true): number | null {
  if (returns.length < 2) return null;
  const excess = returns.map((r) => r - riskFreeRate / TRADING_PERIODS_PER_YEAR);
  const std = stddev(excess);
  if (!std) return null;
  const ratio = mean(excess) / std;
  return annualize ? ratio * Math.sqrt(TRADING_PERIODS_PER_YEAR) : ratio;
}

export function sortinoRatio(returns: number[], riskFreeRate = 0, annualize = true): number | null {
  if (returns.length < 2) return null;
  const excess = returns.map((r) => r - riskFreeRate / TRADING_PERIODS_PER_YEAR);
  const downside = excess.filter((r) => r < 0);
  const downsideStd = downside.length > 1 ? stddev(downside) : 0;
  if (!downsideStd) return null;
  const ratio = mean(excess) / downsideStd;
  return annualize ? ratio * Math.sqrt(TRADING_PERIODS_PER_YEAR) : ratio;
}

export function cagr(equity: number[]): number | null {
  if (equity.length < 2 || equity[0]! <= 0) return null;
  const years = equity.length / TRADING_PERIODS_PER_YEAR;
  if (years <= 0) return null;
  const totalReturn = equity[equity.length - 1]! / equity[0]!;
  if (totalReturn <= 0) return null;
  return totalReturn ** (1 / years) - 1;
}

export function computePortfolioStats(equity: number[]): PortfolioStats {
  const returns = pctChange(equity);
  const [dd, ddDuration] = maxDrawdown(equity);
  return {
    sharpe: sharpeRatio(returns),
    sortino: sortinoRatio(returns),
    maxDrawdownPct: dd,
    maxDrawdownDurationDays: ddDuration,
    volatilityAnnualized: realizedVolatility(returns),
    cagr: cagr(equity),
  };
}
