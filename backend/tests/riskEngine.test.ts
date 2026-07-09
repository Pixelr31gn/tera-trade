import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/engine.js";
import type { AccountRiskState, RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { NewsRiskStatus } from "../src/news/risk.js";

const NO_NEWS: NewsRiskStatus = { inRiskWindow: false, nearestEventName: null, nearestEventTime: null, minutesToEvent: null, impact: null };

function accountState(overrides: Partial<AccountRiskState> = {}): AccountRiskState {
  return {
    currentEquity: new Decimal(50000),
    peakEquity: new Decimal(50000),
    dailyStartingEquity: new Decimal(50000),
    consecutiveLosses: 0,
    tradesToday: 0,
    ...overrides,
  };
}

const BASE_LIMITS: RiskLimitsConfig = {
  perTradeRiskPct: new Decimal("0.5"),
  maxDailyLossPct: new Decimal("3"),
  maxTrailingDrawdownPct: new Decimal("6"),
  maxConsecutiveLosses: 3,
  maxDailyTrades: 13,
  maxPositionSize: 10,
};

describe("RiskEngine.assessNewTrade with fixed-dollar risk/profit", () => {
  it("sizes the position from a fixed dollar risk budget instead of a percentage of equity", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };

    // ATR-based stop distance of 10 points on MNQ (pointValue $2) -- risk/contract = $20 -> floor(50/20) = 2 contracts.
    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667), // 1.5x ATR default multiplier -> ~10 point stop
      structureSwingPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
    });

    expect(assessment.approved).toBe(true);
    expect(assessment.quantity).toBe(2);
    expect(assessment.reason).toContain("$50");
  });

  it("sets the take-profit price from a fixed dollar profit target, reflecting the actual sized quantity", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50"), perTradeProfitDollars: new Decimal("120") };

    const entryPrice = new Decimal(20000);
    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice,
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
    });

    expect(assessment.quantity).toBe(2);
    // $120 profit / (2 contracts * $2/point) = 30 points above entry.
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.plus(30).toNumber(), 1);
  });

  it("mirrors the fixed dollar profit target below entry for a short", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50"), perTradeProfitDollars: new Decimal("120") };

    const entryPrice = new Decimal(20000);
    const assessment = engine.assessNewTrade({
      side: "short",
      entryPrice,
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
    });

    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.minus(30).toNumber(), 1);
  });

  it("falls back to the R:R-based take-profit when no fixed profit target is configured", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50") };

    const entryPrice = new Decimal(20000);
    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice,
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      accountState: accountState(),
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
    });

    // Default takeProfitRMultiple is 2.0x the stop distance -- should NOT be the fixed-dollar-derived 30pt target.
    const stopDistance = entryPrice.minus(assessment.stopPrice!).abs();
    expect(assessment.takeProfitPrice?.toNumber()).toBeCloseTo(entryPrice.plus(stopDistance.times(2)).toNumber(), 1);
  });

  it("respects the fixed-dollar daily loss circuit breaker ahead of sizing", () => {
    const engine = new RiskEngine();
    const limits: RiskLimitsConfig = { ...BASE_LIMITS, perTradeRiskDollars: new Decimal("50"), maxDailyLossDollars: new Decimal("650") };

    const assessment = engine.assessNewTrade({
      side: "long",
      entryPrice: new Decimal(20000),
      atrValue: new Decimal(6.667),
      structureSwingPrice: null,
      accountState: accountState({ currentEquity: new Decimal(49300), dailyStartingEquity: new Decimal(50000) }), // -$700 today
      limits,
      pointValue: new Decimal(2),
      tickSize: new Decimal("0.25"),
      newsStatus: NO_NEWS,
    });

    expect(assessment.approved).toBe(false);
    expect(assessment.tripKillSwitch).toBe(true);
  });
});
