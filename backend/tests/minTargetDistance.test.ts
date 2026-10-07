import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/engine.js";
import { DEFAULT_CONFIDENCE_TIERS } from "../src/risk/sizing.js";
import { fiveMinuteAtrPoints } from "../src/risk/stops.js";
import type { RiskLimitsConfig } from "../src/risk/circuitBreakers.js";
import type { OhlcBar } from "../src/regime/indicators.js";

// 200 one-minute bars, each spanning 19998-20002: every 5-minute bar's true
// range is 4 points, so the 5-minute ATR is 4 and the minimum target 12.
function choppyBars(): OhlcBar[] {
  const base = new Date("2026-10-06T13:00:00Z").getTime();
  return Array.from({ length: 200 }, (_, i) => ({ time: new Date(base + i * 60_000), open: 20000, high: 20002, low: 19998, close: 20000, volume: 100 }));
}

const LIMITS: RiskLimitsConfig = {
  perTradeRiskPct: new Decimal("0.5"),
  maxDailyLossPct: new Decimal("3"),
  maxTrailingDrawdownPct: new Decimal("6"),
  maxConsecutiveLosses: 3,
  maxDailyTrades: 13,
  maxPositionSize: 10,
};

function assess(side: "long" | "short", assistantTakeProfitCapPoints: Decimal | null = null) {
  return new RiskEngine().assessNewTrade({
    side,
    entryPrice: new Decimal(20000),
    atrValue: new Decimal("0.5"), // 1-minute ATR this small used to give a ~0.75pt stop / ~2.25pt target
    structureSwingPrice: null, signalKind: "reversal", breakoutLevelPrice: null,
    accountState: { currentEquity: new Decimal(50000), peakEquity: new Decimal(50000), dailyStartingEquity: new Decimal(50000), consecutiveLosses: 0, tradesToday: 0 },
    limits: LIMITS,
    pointValue: new Decimal(2),
    tickSize: new Decimal("0.25"),
    newsStatus: { inRiskWindow: false, nearestEventName: null, nearestEventTime: null, minutesToEvent: null, impact: null },
    bars: choppyBars(),
    averageProbability: 0.75,
    takeProfitRMultiple: new Decimal("3.0"),
    confidenceTiers: DEFAULT_CONFIDENCE_TIERS,
    srGateBypass: true,
    assistantTakeProfitCapPoints,
  });
}

describe("fiveMinuteAtrPoints", () => {
  it("reads the ATR of 5-minute bars built from 1-minute bars", () => {
    expect(fiveMinuteAtrPoints(choppyBars())!.toNumber()).toBeCloseTo(4, 5);
  });

  it("is null without enough bars", () => {
    expect(fiveMinuteAtrPoints(choppyBars().slice(0, 20))).toBeNull();
  });
});

describe("minimum take-profit distance (3x the 5-minute ATR)", () => {
  it("pushes a cramped long target out to the minimum and keeps the stop at a third of it", () => {
    const a = assess("long");
    expect(a.approved).toBe(true);
    expect(a.takeProfitPrice!.minus(20000).toNumber()).toBeGreaterThanOrEqual(12);
    expect(new Decimal(20000).minus(a.stopPrice!).toNumber()).toBeCloseTo(4, 0);
    expect(a.reason).toContain("5-minute ATR");
  });

  it("does the same for a short", () => {
    const a = assess("short");
    expect(a.approved).toBe(true);
    expect(new Decimal(20000).minus(a.takeProfitPrice!).toNumber()).toBeGreaterThanOrEqual(12);
    expect(a.stopPrice!.minus(20000).toNumber()).toBeCloseTo(4, 0);
  });

  it("skips the trade when the session cap leaves less room than the minimum", () => {
    const a = assess("long", new Decimal(6));
    expect(a.approved).toBe(false);
    expect(a.reason).toContain("take-profit room too small");
  });

  it("still trades when the session cap allows the minimum", () => {
    const a = assess("long", new Decimal(30));
    expect(a.approved).toBe(true);
    expect(a.takeProfitPrice!.minus(20000).toNumber()).toBeGreaterThanOrEqual(12);
  });
});
