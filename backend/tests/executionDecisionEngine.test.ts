import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import { BrokerKind } from "../src/core/config.js";
import type { BrokerClient, OrderResult } from "../src/brokers/types.js";
import type { EmaTrend } from "../src/analytics/emaTrend.js";
import type { OhlcBar } from "../src/regime/indicators.js";

// Regression coverage for the 2026-07-20 incident: a real resting order
// filled but sat undetected for ~20 minutes (fill-polling was only ever
// reachable from a fresh signal reaching consensus again), and a later
// opposite-side signal then collided with that same in-memory slot and
// recorded a fabricated trade. Both root causes live in the opportunity map
// itself, so the ladder-scoring machinery is mocked out here -- it's already
// covered by entryQualityModel.test.ts -- to isolate exactly the map-keying
// and polling behavior that actually broke.
vi.mock("../src/execution/entryQualityModel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/execution/entryQualityModel.js")>();
  return { ...actual, scoreEntryLadder: vi.fn(() => [{ price: 20000, score: 80, factors: [] }]) };
});
vi.mock("../src/execution/fairValueMap.js", () => ({
  buildFairValueMap: vi.fn(() => ({
    currentPrice: 20000, atrValue: 10, srLevels: [],
    volumeProfile: { levels: [], poc: null, valueAreaHigh: null, valueAreaLow: null, highVolumeNodes: [], lowVolumeNodes: [] },
    sessionVwap: 20000, rollingVwap: 20000,
    bollinger: { middle: 20000, upper: 20020, lower: 19980, bandwidth: 0.002 },
    keltner: { middle: 20000, upper: 20020, lower: 19980 },
    absorption: { detected: false, side: null, description: "none" },
    deltaDivergence: { divergent: false, cumulativeDelta: 0, description: "none" },
    rsi: 50,
  })),
}));
vi.mock("../src/engine/liveOrderFlowCache.js", () => ({ getOrderFlowHistory: vi.fn(() => []) }));
vi.mock("../src/db/client.js", () => ({
  prisma: {
    trade: { create: vi.fn(async () => ({ id: 999 })) },
    score: { update: vi.fn(async () => ({})) },
    orderRecord: { create: vi.fn(async () => ({})) },
  },
}));

const { evaluateExecutionOpportunity, pollRestingOpportunities, getExecutionOpportunitiesSnapshot, _resetExecutionOpportunitiesForTests } = await import(
  "../src/execution/executionDecisionEngine.js"
);

const NEUTRAL_TREND: EmaTrend = { ema: 20000, slope: 0.001, label: "neutral" };
const BARS: OhlcBar[] = Array.from({ length: 30 }, (_, i) => ({
  time: new Date(2026, 0, 1, 0, i),
  open: 20000, high: 20010, low: 19990, close: 20000, volume: 1000,
}));

function mockBroker(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getAccounts: vi.fn(async () => []),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    placeOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "test-order", status: "pending" })),
    cancelOrder: vi.fn(async () => true),
    getHistoricalBars: vi.fn(async () => []),
    isPositionFlat: vi.fn(async () => true),
    cancelRestingOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "", status: "rejected" })),
    ...overrides,
  };
}

function baseParams(overrides: Partial<Parameters<typeof evaluateExecutionOpportunity>[0]> = {}) {
  return {
    symbol: "NQ",
    side: "short" as const,
    strategyId: "continuous_v3_scan_short",
    signalScore: 0.8,
    currentPrice: new Decimal(20000),
    atrValue: new Decimal(10),
    tickSize: new Decimal(0.25),
    stopPrice: new Decimal(20050),
    takeProfitPrice: new Decimal(19900),
    quantity: 3,
    bars: BARS,
    barTime: new Date(2026, 0, 1, 1, 0),
    emaTrend: NEUTRAL_TREND,
    broker: mockBroker(),
    brokerKind: BrokerKind.BROWSER_CONTROL,
    accountId: 1,
    brokerAccountId: "acct-1",
    regimeTrend: "downtrend",
    regimeVol: "normal",
    explanation: "test signal",
    scoreId: null,
    ...overrides,
  };
}

describe("evaluateExecutionOpportunity -- opposite-side collision guard", () => {
  beforeEach(() => _resetExecutionOpportunitiesForTests());

  it("places a resting order for the first side reaching ready", async () => {
    const broker = mockBroker();
    const result = await evaluateExecutionOpportunity(baseParams({ side: "short", broker }));
    expect(result.action).toBe("placed_resting_order");
    expect(broker.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("declines a signal on the opposite side while one side already has an active opportunity, instead of colliding with its map slot", async () => {
    const shortBroker = mockBroker();
    const shortResult = await evaluateExecutionOpportunity(baseParams({ side: "short", broker: shortBroker }));
    expect(shortResult.action).toBe("placed_resting_order");

    const longBroker = mockBroker();
    const longResult = await evaluateExecutionOpportunity(baseParams({ side: "long", broker: longBroker, strategyId: "continuous_v3_scan_long" }));

    expect(longResult.action).toBe("waiting");
    expect(longResult.reason).toContain("declining -- opposite side");
    expect(longBroker.placeOrder).not.toHaveBeenCalled();

    // The 2026-07-20 bug: this used to look up the SAME "NQ" map slot the
    // short opportunity was already using, read its "not flat" broker check
    // as its own fill, and fabricate a long trade. Confirm only the short
    // opportunity exists now -- no phantom long ever gets created.
    const snapshot = getExecutionOpportunitiesSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.side).toBe("short");
  });
});

describe("pollRestingOpportunities -- fill/age polling independent of a fresh signal", () => {
  beforeEach(() => _resetExecutionOpportunitiesForTests());

  it("detects an age-based cancellation for a resting order with no fresh evaluateExecutionOpportunity call in between", async () => {
    const broker = mockBroker({ isPositionFlat: vi.fn(async () => true) }); // still flat -- never filled
    await evaluateExecutionOpportunity(baseParams({ side: "short", broker, barTime: new Date(2026, 0, 1, 1, 0) }));

    // Nothing re-invokes evaluateExecutionOpportunity for this side at all --
    // this is the exact gap that let a real fill sit undetected for ~20
    // minutes: the old code only ever checked a resting order from inside a
    // fresh signal's own consensus-gated call.
    const muchLater = new Date(2026, 0, 1, 1, 9); // 9 minutes later, past the 8-minute cancel threshold
    const pollResults = await pollRestingOpportunities({ symbol: "NQ", broker, brokerKind: BrokerKind.BROWSER_CONTROL, barTime: muchLater });

    expect(pollResults).toHaveLength(1);
    expect(pollResults[0]!.action).toBe("cancelled");
    expect(broker.cancelRestingOrder).toHaveBeenCalledWith("NQ");
    expect(getExecutionOpportunitiesSnapshot()).toHaveLength(0);
  });

  it("detects a fill with no fresh evaluateExecutionOpportunity call in between", async () => {
    const broker = mockBroker({ isPositionFlat: vi.fn(async () => true) });
    await evaluateExecutionOpportunity(baseParams({ side: "short", broker }));

    // Broker now reports a real position -- simulates the fill happening
    // between ticks, with nothing but the poll noticing it.
    const flatNowBroker = { ...broker, isPositionFlat: vi.fn(async () => false) };
    const result = await pollRestingOpportunities({ symbol: "NQ", broker: flatNowBroker, brokerKind: BrokerKind.BROWSER_CONTROL, barTime: new Date(2026, 0, 1, 1, 5) });

    expect(result).toHaveLength(1);
    expect(result[0]!.action).toBe("filled");
    expect(result[0]!.tradeId).toBe(999);
    expect(getExecutionOpportunitiesSnapshot()).toHaveLength(0);
  });

  it("returns an empty array when there is no resting opportunity for the symbol", async () => {
    const broker = mockBroker();
    const result = await pollRestingOpportunities({ symbol: "NQ", broker, brokerKind: BrokerKind.BROWSER_CONTROL, barTime: new Date() });
    expect(result).toEqual([]);
  });
});
