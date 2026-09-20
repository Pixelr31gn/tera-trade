import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { getConflictingPartnerSymbol } from "../src/marketData/instruments.js";
import { ReplayDecisionContext } from "../src/replay/replayDecisionContext.js";
import { DEFAULT_CONFIDENCE_TIERS } from "../src/risk/sizing.js";
import type { RiskLimitsConfig } from "../src/risk/circuitBreakers.js";

const LIMITS: RiskLimitsConfig = {
  perTradeRiskPct: new Decimal("0.5"),
  maxDailyLossPct: new Decimal("3"),
  maxTrailingDrawdownPct: new Decimal("6"),
  maxConsecutiveLosses: 3,
  maxDailyTrades: 13,
  maxPositionSize: 10,
};

describe("getConflictingPartnerSymbol", () => {
  it("maps ES <-> NQ both directions", () => {
    expect(getConflictingPartnerSymbol("ES")).toBe("NQ");
    expect(getConflictingPartnerSymbol("NQ")).toBe("ES");
  });

  it("returns null for a symbol with no defined partner", () => {
    expect(getConflictingPartnerSymbol("CL")).toBeNull();
    expect(getConflictingPartnerSymbol("GC")).toBeNull();
  });
});

// 2026-09-01, operator request: "ES and NQ should never enter into
// conflicting trades" -- these exercise ReplayDecisionContext's in-memory
// side of hasConflictingPosition directly (no DB touched: markOpen/
// hasConflictingPosition are pure Map operations, same as hasOpenPosition
// already is), so replay honors the same rule live does via
// engine/crossSymbolConflictCheck.ts.
describe("ReplayDecisionContext.hasConflictingPosition", () => {
  function ctx() {
    return new ReplayDecisionContext(new Map(), 50000, LIMITS, { takeProfitRMultiple: new Decimal("2.0"), confidenceTiers: DEFAULT_CONFIDENCE_TIERS });
  }

  it("is false with no open positions at all", async () => {
    const c = ctx();
    expect(await c.hasConflictingPosition("ES", "long")).toBe(false);
  });

  it("is true when the partner symbol is open on the opposite side", async () => {
    const c = ctx();
    c.markOpen("NQ", { side: "long", entryPrice: new Decimal(29000), quantity: 5, pointValue: new Decimal(2) });
    expect(await c.hasConflictingPosition("ES", "short")).toBe(true);
    expect(await c.hasConflictingPosition("ES", "long")).toBe(false); // same direction -- not a conflict
  });

  it("is symmetric -- checking from either symbol's side agrees", async () => {
    const c = ctx();
    c.markOpen("ES", { side: "short", entryPrice: new Decimal(7700), quantity: 5, pointValue: new Decimal(5) });
    expect(await c.hasConflictingPosition("NQ", "long")).toBe(true);
    expect(await c.hasConflictingPosition("NQ", "short")).toBe(false);
  });

  it("clears once the conflicting position is marked closed", async () => {
    const c = ctx();
    c.markOpen("NQ", { side: "long", entryPrice: new Decimal(29000), quantity: 5, pointValue: new Decimal(2) });
    expect(await c.hasConflictingPosition("ES", "short")).toBe(true);
    c.markClosed("NQ");
    expect(await c.hasConflictingPosition("ES", "short")).toBe(false);
  });

  it("is always false for a symbol with no defined conflicting partner", async () => {
    const c = ctx();
    c.markOpen("NQ", { side: "long", entryPrice: new Decimal(29000), quantity: 5, pointValue: new Decimal(2) });
    expect(await c.hasConflictingPosition("CL", "short")).toBe(false);
  });

  it("GC has no defined conflicting partner (2026-09-03 addition -- no correlation basis assumed)", () => {
    expect(getConflictingPartnerSymbol("GC")).toBeNull();
  });
});

// 2026-09-03, operator request: "add a toggle so i can turn off which
// markets are executable" -- replay always sees every symbol enabled, same
// posture as disabledStrategyIds (a live operator toggle has no meaning for
// a historical replay date). See engine/symbolEnablementCache.ts for the
// live side (a thin Prisma wrapper, not unit-tested here, same convention
// as strategyEnablementCache.ts).
describe("ReplayDecisionContext.disabledSymbols", () => {
  it("is always an empty set, regardless of what's open", async () => {
    const c = new ReplayDecisionContext(new Map(), 50000, LIMITS, { takeProfitRMultiple: new Decimal("2.0"), confidenceTiers: DEFAULT_CONFIDENCE_TIERS });
    expect(await c.disabledSymbols()).toEqual(new Set());
    c.markOpen("NQ", { side: "long", entryPrice: new Decimal(29000), quantity: 5, pointValue: new Decimal(2) });
    expect(await c.disabledSymbols()).toEqual(new Set());
  });
});

// 2026-09-04, operator request: "only trade the winning signals" -- finer than
// disabledStrategyIds/disabledSymbols above (one strategyId, one symbol), same replay posture
// (a live operator toggle has no meaning for a historical replay date). Live side (a thin Prisma
// wrapper, engine/strategySymbolEnablementCache.ts) not unit-tested here, same convention as
// strategyEnablementCache.ts/symbolEnablementCache.ts.
describe("ReplayDecisionContext.disabledStrategySymbolPairs", () => {
  it("is always an empty set, regardless of what's open", async () => {
    const c = new ReplayDecisionContext(new Map(), 50000, LIMITS, { takeProfitRMultiple: new Decimal("2.0"), confidenceTiers: DEFAULT_CONFIDENCE_TIERS });
    expect(await c.disabledStrategySymbolPairs()).toEqual(new Set());
    c.markOpen("NQ", { side: "long", entryPrice: new Decimal(29000), quantity: 5, pointValue: new Decimal(2) });
    expect(await c.disabledStrategySymbolPairs()).toEqual(new Set());
  });
});
