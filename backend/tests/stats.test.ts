import { describe, expect, it } from "vitest";
import { computeTradeStats, maxDrawdown, computePortfolioStats, sharpeRatio, sortinoRatio, realizedVolatility } from "../src/analytics/stats.js";

describe("computeTradeStats", () => {
  it("returns zeroed/null stats for an empty trade list", () => {
    const stats = computeTradeStats([]);
    expect(stats).toEqual({ tradeCount: 0, winRate: 0, expectedValue: 0, profitFactor: null, avgWin: 0, avgLoss: 0, avgMae: null, avgMfe: null, largestWin: 0, largestLoss: 0 });
  });

  it("computes win rate, expected value, and profit factor from mixed wins/losses", () => {
    const stats = computeTradeStats([{ pnl: 100 }, { pnl: -50 }, { pnl: 200 }, { pnl: -50 }]);
    expect(stats.tradeCount).toBe(4);
    expect(stats.winRate).toBe(0.5);
    expect(stats.expectedValue).toBe(50); // (100-50+200-50)/4
    expect(stats.profitFactor).toBe(3); // grossProfit 300 / grossLoss 100
    expect(stats.avgWin).toBe(150);
    expect(stats.avgLoss).toBe(-50);
    expect(stats.largestWin).toBe(200);
    expect(stats.largestLoss).toBe(-50);
  });

  it("returns null profit factor when there are no losses to divide by", () => {
    const stats = computeTradeStats([{ pnl: 100 }, { pnl: 50 }]);
    expect(stats.profitFactor).toBeNull();
  });

  it("averages MAE/MFE only over trades that actually recorded them", () => {
    const stats = computeTradeStats([{ pnl: 10, mae: 5, mfe: 8 }, { pnl: -5, mae: null, mfe: null }, { pnl: 20, mae: 3, mfe: 12 }]);
    expect(stats.avgMae).toBe(4); // (5+3)/2, the null row excluded
    expect(stats.avgMfe).toBe(10); // (8+12)/2
  });
});

describe("maxDrawdown", () => {
  it("computes zero drawdown for a monotonically rising equity curve", () => {
    const [dd] = maxDrawdown([100, 110, 120, 130]);
    expect(dd).toBe(0);
  });

  it("computes a bounded (0-1) drawdown fraction for a normal decline from peak", () => {
    const [dd] = maxDrawdown([100, 120, 90, 110]); // peak 120, trough 90 -> 25% drawdown
    expect(dd).toBeCloseTo(0.25, 5);
  });

  it("tracks the longest underwater duration in periods, not just the deepest point", () => {
    const [, duration] = maxDrawdown([100, 90, 95, 80, 105, 90]); // underwater for periods 2-6 (5 periods) after the peak at index 0... measured via the current/longest counters
    expect(duration).toBeGreaterThan(0);
  });
});

describe("computePortfolioStats -- non-positive equity guard", () => {
  // Regression coverage for the 2026-08-11 dashboard bug ("Max Drawdown
  // 100.9%", Sharpe/Sortino/Volatility all blank) -- traced to real
  // corrupted equity_curve rows (a scraped-balance artifact, zero trades
  // executed during the window) reaching zero/negative. See stats.ts's
  // own comment on computePortfolioStats for the full incident writeup.
  const cleanEquity = Array.from({ length: 30 }, (_, i) => 50000 + Math.sin(i / 3) * 2000 + i * 50);

  it("never reports a drawdown exceeding 100%, even with a corrupted non-positive point spliced in", () => {
    const corrupted = [...cleanEquity.slice(0, 15), -873.42, ...cleanEquity.slice(15)];
    const stats = computePortfolioStats(corrupted);
    expect(stats.maxDrawdownPct).toBeLessThanOrEqual(1);
  });

  it("still computes real Sharpe/Sortino/volatility numbers instead of nulling out the whole history over one bad point", () => {
    const clean = computePortfolioStats(cleanEquity);
    const corrupted = computePortfolioStats([...cleanEquity.slice(0, 15), 0, ...cleanEquity.slice(15)]);
    expect(clean.sharpe).not.toBeNull();
    expect(corrupted.sharpe).not.toBeNull();
    expect(corrupted.sortino).not.toBeNull();
    expect(corrupted.volatilityAnnualized).not.toBeNull();
    // The corrupted point is excluded outright, not clamped/interpolated --
    // same underlying return series modulo the missing point, so the two
    // should land close to each other rather than the corruption dragging
    // the ratio to an extreme.
    expect(corrupted.sharpe!).toBeCloseTo(clean.sharpe!, 0);
  });

  it("excludes multiple non-positive points scattered through the series", () => {
    const corrupted = [...cleanEquity, 0, -100, -50];
    const stats = computePortfolioStats(corrupted);
    expect(stats.maxDrawdownPct).toBeLessThanOrEqual(1);
    expect(Number.isFinite(stats.maxDrawdownPct)).toBe(true);
  });
});

describe("sharpeRatio / sortinoRatio / realizedVolatility -- null edge cases", () => {
  it("returns null with fewer than 2 return periods", () => {
    expect(sharpeRatio([0.01])).toBeNull();
    expect(sortinoRatio([0.01])).toBeNull();
    expect(realizedVolatility([0.01])).toBeNull();
  });

  it("returns null when there is no return variance at all (zero std dev)", () => {
    expect(sharpeRatio([0.01, 0.01, 0.01])).toBeNull();
  });

  it("returns null sortino when there are no downside (losing) periods to measure against", () => {
    expect(sortinoRatio([0.01, 0.02, 0.03])).toBeNull();
  });
});
