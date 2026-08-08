import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import { TradingMode, BrokerKind } from "../src/core/config.js";
import type { BrokerClient, OrderResult } from "../src/brokers/types.js";
import type { RiskAssessment } from "../src/risk/engine.js";
import type { GatedScore } from "../src/scoring/gate.js";
import type { Signal } from "../src/strategy/types.js";

// Limit-only entries (2026-08-07, operator request: "as fast as possible,
// only enter using limit orders") -- see execution/engine.ts's
// LIMIT_FILL_CONFIRMATION_RETRIES comment for the full rationale.
const created: { trade: unknown[]; orderRecord: unknown[] } = { trade: [], orderRecord: [] };
vi.mock("../src/db/client.js", () => ({
  prisma: {
    trade: {
      create: vi.fn(async (args: { data: unknown }) => {
        created.trade.push(args.data);
        return { id: 1, ...(args.data as object) };
      }),
    },
    orderRecord: {
      create: vi.fn(async (args: { data: unknown }) => {
        created.orderRecord.push(args.data);
        return {};
      }),
    },
    score: { update: vi.fn(async () => ({})) },
  },
}));

const { executeIfApproved } = await import("../src/execution/engine.js");

function mockBroker(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getAccounts: vi.fn(async () => []),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    placeOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "test-order", status: "filled", filledPrice: new Decimal(20000), filledAt: new Date() })),
    cancelOrder: vi.fn(async () => true),
    getHistoricalBars: vi.fn(async () => []),
    isPositionFlat: vi.fn(async () => false),
    cancelRestingOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "", status: "rejected" })),
    ...overrides,
  };
}

const SIGNAL: Signal = {
  strategyId: "continuous_v3_scan_long",
  symbol: "NQ",
  side: "long",
  structureSwingPrice: new Decimal(19950),
  reason: "test signal",
  signalKind: "reversal",
};

const GATED: GatedScore = { probability: 0.8, decision: "taken", factors: [], modelUsed: "rule_v6", blockReason: null, v3Bucket: null };

const ASSESSMENT: RiskAssessment = {
  approved: true,
  quantity: 1,
  stopPrice: new Decimal(19990),
  takeProfitPrice: new Decimal(20020),
  trailTicks: 30,
  stopDistancePoints: new Decimal(10),
  reason: "ok",
  tripKillSwitch: false,
  nearestSrLevel: null,
};

const ENTRY_PRICE = new Decimal(20000);

function run(broker: BrokerClient) {
  return executeIfApproved(broker, BrokerKind.BROWSER_CONTROL, TradingMode.LIVE, 1, "broker-acct-1", SIGNAL, GATED, ASSESSMENT, ENTRY_PRICE, "up", "trending", "test explanation");
}

describe("executeIfApproved -- limit-only entries", () => {
  beforeEach(() => {
    created.trade.length = 0;
    created.orderRecord.length = 0;
  });

  it("places a limit order at the signal's entry price, not a market order", async () => {
    const broker = mockBroker();
    await run(broker);
    const placeOrderMock = broker.placeOrder as ReturnType<typeof vi.fn>;
    const request = placeOrderMock.mock.calls[0][0];
    expect(request.orderType).toBe("limit");
    expect(request.limitPrice.toNumber()).toBe(20000);
  });

  it("records the trade as filled immediately when the broker fills the limit order right away", async () => {
    const broker = mockBroker({
      placeOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "x", status: "filled", filledPrice: new Decimal(20000), filledAt: new Date() })),
    });
    const result = await run(broker);
    expect(result.executed).toBe(true);
    expect(broker.cancelRestingOrder).not.toHaveBeenCalled();
  });

  it("polls isPositionFlat and confirms the trade once a resting limit order fills", async () => {
    let call = 0;
    const broker = mockBroker({
      placeOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "x", status: "pending" })),
      // Reads flat (true) the first two polls, then confirms filled (false) on the third.
      isPositionFlat: vi.fn(async () => {
        call++;
        return call < 3;
      }),
    });
    const result = await run(broker);
    expect(result.executed).toBe(true);
    expect(broker.cancelRestingOrder).not.toHaveBeenCalled();
  });

  it("cancels the resting order and skips the trade -- no fallback to a market order -- when it never fills", async () => {
    const broker = mockBroker({
      placeOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "x", status: "pending" })),
      isPositionFlat: vi.fn(async () => true), // never confirms a fill
    });
    const result = await run(broker);
    expect(result.executed).toBe(false);
    expect(result.tradeId).toBeNull();
    expect(result.reason).toContain("did not fill");
    expect(broker.cancelRestingOrder).toHaveBeenCalledWith("NQ");
    expect(created.trade).toHaveLength(0);
  });

  it("still rejects cleanly when the broker rejects the order outright", async () => {
    const broker = mockBroker({
      placeOrder: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "", status: "rejected", error: "no order-entry widget found" })),
    });
    const result = await run(broker);
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("broker rejected the order");
  });
});
