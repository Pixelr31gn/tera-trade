import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { checkCircuitBreakers, type AccountRiskState, type RiskLimitsConfig } from "../src/risk/circuitBreakers.js";

const LIMITS: RiskLimitsConfig = {
  perTradeRiskPct: new Decimal("0.5"),
  maxDailyLossPct: new Decimal("3"),
  maxTrailingDrawdownPct: new Decimal("6"),
  maxConsecutiveLosses: 3,
  maxDailyTrades: 8,
  maxPositionSize: 3,
};

function state(overrides: Partial<AccountRiskState>): AccountRiskState {
  return {
    currentEquity: new Decimal(50000),
    peakEquity: new Decimal(51000),
    dailyStartingEquity: new Decimal(50200),
    consecutiveLosses: 0,
    tradesToday: 1,
    ...overrides,
  };
}

describe("checkCircuitBreakers", () => {
  it("allows a trade within all limits", () => {
    expect(checkCircuitBreakers(state({}), LIMITS).allowed).toBe(true);
  });

  it("trips the kill switch on daily loss limit breach", () => {
    const decision = checkCircuitBreakers(state({ currentEquity: new Decimal(48000) }), LIMITS); // -4% today
    expect(decision.allowed).toBe(false);
    expect(decision.tripKillSwitch).toBe(true);
  });

  it("trips the kill switch on trailing drawdown breach", () => {
    const decision = checkCircuitBreakers(state({ currentEquity: new Decimal(47000), dailyStartingEquity: new Decimal(50500) }), LIMITS); // ~7.8% trailing
    expect(decision.allowed).toBe(false);
    expect(decision.tripKillSwitch).toBe(true);
  });

  it("pauses without kill switch on consecutive losses", () => {
    const decision = checkCircuitBreakers(state({ consecutiveLosses: 3 }), LIMITS);
    expect(decision.allowed).toBe(false);
    expect(decision.tripKillSwitch).toBe(false);
  });

  it("pauses without kill switch at the max daily trade count", () => {
    const decision = checkCircuitBreakers(state({ tradesToday: 8 }), LIMITS);
    expect(decision.allowed).toBe(false);
    expect(decision.tripKillSwitch).toBe(false);
  });

  it("trips the kill switch on a fixed-dollar daily loss breach, checked ahead of the percentage limit", () => {
    const limitsWithDollarCap: RiskLimitsConfig = { ...LIMITS, maxDailyLossDollars: new Decimal("650") };
    // $700 down today -- breaches the $650 cap even though the % loss alone is well under maxDailyLossPct.
    const decision = checkCircuitBreakers(state({ currentEquity: new Decimal(49500), dailyStartingEquity: new Decimal(50200) }), limitsWithDollarCap);
    expect(decision.allowed).toBe(false);
    expect(decision.tripKillSwitch).toBe(true);
    expect(decision.reason).toContain("$650");
  });

  it("does not apply the fixed-dollar daily loss cap when it isn't configured", () => {
    const decision = checkCircuitBreakers(state({ currentEquity: new Decimal(49500), dailyStartingEquity: new Decimal(50200) }), LIMITS);
    expect(decision.allowed).toBe(true);
  });
});
