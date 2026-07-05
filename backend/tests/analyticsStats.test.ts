import { describe, expect, it } from "vitest";
import { computePortfolioStats, computeTradeStats, maxDrawdown, sharpeRatio, sortinoRatio } from "../src/analytics/stats.js";

describe("computeTradeStats", () => {
  it("computes basic stats", () => {
    const trades = [
      { pnl: 100, mae: 10, mfe: 120 },
      { pnl: -50, mae: 20, mfe: 30 },
      { pnl: 200, mae: 5, mfe: 220 },
      { pnl: -50, mae: 15, mfe: 40 },
      { pnl: 300, mae: 8, mfe: 310 },
    ];
    const stats = computeTradeStats(trades);
    expect(stats.tradeCount).toBe(5);
    expect(stats.winRate).toBeCloseTo(3 / 5);
    expect(stats.expectedValue).toBeCloseTo(100);
    expect(stats.profitFactor).toBeCloseTo(600 / 100);
    expect(stats.avgWin).toBeCloseTo((100 + 200 + 300) / 3);
    expect(stats.avgLoss).toBeCloseTo(-50);
  });

  it("handles an empty trade list", () => {
    const stats = computeTradeStats([]);
    expect(stats.tradeCount).toBe(0);
    expect(stats.profitFactor).toBeNull();
  });

  it("returns null profit factor when there are no losses", () => {
    const stats = computeTradeStats([{ pnl: 10 }, { pnl: 20 }, { pnl: 30 }]);
    expect(stats.profitFactor).toBeNull();
  });
});

describe("maxDrawdown", () => {
  it("detects peak-to-trough drawdown", () => {
    const [dd, duration] = maxDrawdown([100, 110, 105, 90, 95, 120]);
    expect(dd).toBeCloseTo((110 - 90) / 110);
    expect(duration).toBeGreaterThanOrEqual(1);
  });
});

describe("sharpeRatio / sortinoRatio", () => {
  it("are positive for an upward-drifting return series", () => {
    const returns = [0.01, 0.02, -0.005, 0.015, 0.01, 0.02, -0.01, 0.03];
    expect(sharpeRatio(returns)).toBeGreaterThan(0);
    expect(sortinoRatio(returns)).toBeGreaterThan(0);
  });
});

describe("computePortfolioStats", () => {
  it("returns sane values for a smooth uptrend", () => {
    const equity = Array.from({ length: 60 }, (_, i) => 100 + i + (i % 5 === 0 ? 1 : 0));
    const stats = computePortfolioStats(equity);
    expect(stats.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });
});
