import { Decimal } from "decimal.js";
import { describe, expect, it, vi } from "vitest";

import { FanOutBroker, applyMirrorCommand } from "../src/multiAccount/fanOutBroker.js";
import type { MirrorCommand, RemoteExecutor } from "../src/multiAccount/fanOutTypes.js";
import type { BrokerClient, OrderRequest, OrderResult } from "../src/brokers/types.js";
import { OrderSide, OrderType } from "../src/brokers/types.js";

// A BrokerClient that records every call and returns canned results.
function makeRecordingBroker(result: OrderResult = { brokerOrderId: "m1", status: "filled" }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve(result);
  };
  const broker: BrokerClient = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getAccounts: vi.fn(async () => []),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    getHistoricalBars: vi.fn(async () => []),
    cancelOrder: vi.fn(async () => true),
    placeOrder: rec("placeOrder") as BrokerClient["placeOrder"],
    requestClosePosition: rec("requestClosePosition") as NonNullable<BrokerClient["requestClosePosition"]>,
    flattenPosition: rec("flattenPosition") as NonNullable<BrokerClient["flattenPosition"]>,
    placeTrailingStop: rec("placeTrailingStop") as NonNullable<BrokerClient["placeTrailingStop"]>,
    placeTakeProfitOrder: rec("placeTakeProfitOrder") as NonNullable<BrokerClient["placeTakeProfitOrder"]>,
    cancelRestingOrder: rec("cancelRestingOrder") as NonNullable<BrokerClient["cancelRestingOrder"]>,
    isPositionFlat: vi.fn(async () => null),
    readOpenPositionEntryPrice: vi.fn(async () => null),
    readClosedTradeHistory: vi.fn(async () => null),
  };
  return { broker, calls };
}

function makeExecutor(name: string, opts: { result?: OrderResult; throwErr?: string } = {}): {
  executor: RemoteExecutor;
  received: MirrorCommand[];
} {
  const received: MirrorCommand[] = [];
  const executor: RemoteExecutor = {
    name,
    dispatch: async (command) => {
      received.push(command);
      if (opts.throwErr) throw new Error(opts.throwErr);
      return opts.result ?? { brokerOrderId: `${name}-ok`, status: "filled" };
    },
  };
  return { executor, received };
}

const sampleOrder: OrderRequest = {
  accountId: "browser",
  symbol: "NQ",
  side: OrderSide.BUY,
  orderType: OrderType.MARKET,
  quantity: 2,
  referencePrice: new Decimal(20000),
  stopLossPrice: new Decimal(19950),
};

describe("FanOutBroker", () => {
  it("placeOrder runs on the master AND every executor, once each", async () => {
    const { broker, calls } = makeRecordingBroker();
    const a = makeExecutor("pc2");
    const b = makeExecutor("pc3");
    const fan = new FanOutBroker(broker, [a.executor, b.executor]);

    await fan.placeOrder(sampleOrder);

    expect(calls.map((c) => c.method)).toEqual(["placeOrder"]);
    expect(a.received).toEqual([{ kind: "placeOrder", request: sampleOrder }]);
    expect(b.received).toEqual([{ kind: "placeOrder", request: sampleOrder }]);
  });

  it("returns the MASTER result, and a remote rejection/throw never changes it", async () => {
    const { broker } = makeRecordingBroker({ brokerOrderId: "master-123", status: "filled" });
    const bad = makeExecutor("pc2", { throwErr: "network down" });
    const rejecting = makeExecutor("pc3", { result: { brokerOrderId: "", status: "rejected", error: "locked out" } });
    const fan = new FanOutBroker(broker, [bad.executor, rejecting.executor]);

    const result = await fan.placeOrder(sampleOrder);

    expect(result).toEqual({ brokerOrderId: "master-123", status: "filled" });
    // both executors were still attempted
    expect(bad.received).toHaveLength(1);
    expect(rejecting.received).toHaveLength(1);
  });

  it("read/decision methods are NEVER mirrored to executors", async () => {
    const { broker } = makeRecordingBroker();
    const a = makeExecutor("pc2");
    const fan = new FanOutBroker(broker, [a.executor]);

    await fan.getAccounts();
    await fan.isPositionFlat("NQ");
    await fan.readOpenPositionEntryPrice("NQ");
    await fan.readClosedTradeHistory("NQ");
    await fan.getPositions("browser");

    expect(a.received).toEqual([]);
  });

  it("each state-changing method mirrors the correct command", async () => {
    const { broker } = makeRecordingBroker();
    const a = makeExecutor("pc2");
    const fan = new FanOutBroker(broker, [a.executor]);

    await fan.requestClosePosition("NQ");
    await fan.flattenPosition("NQ", "long", 3);
    await fan.placeTrailingStop("NQ", "long", 3, 10);
    await fan.placeTakeProfitOrder("NQ", "long", 3, new Decimal(20100));
    await fan.cancelRestingOrder("NQ");

    expect(a.received).toEqual([
      { kind: "requestClosePosition", symbol: "NQ" },
      { kind: "flattenPosition", symbol: "NQ", side: "long", quantity: 3 },
      { kind: "placeTrailingStop", symbol: "NQ", side: "long", quantity: 3, trailTicks: 10 },
      { kind: "placeTakeProfitOrder", symbol: "NQ", side: "long", quantity: 3, limitPrice: new Decimal(20100) },
      { kind: "cancelRestingOrder", symbol: "NQ" },
    ]);
  });

  it("a master throw propagates (matches a direct broker call)", async () => {
    const { broker } = makeRecordingBroker();
    broker.placeOrder = vi.fn(async () => {
      throw new Error("master boom");
    });
    const a = makeExecutor("pc2");
    const fan = new FanOutBroker(broker, [a.executor]);

    await expect(fan.placeOrder(sampleOrder)).rejects.toThrow("master boom");
  });
});

describe("applyMirrorCommand", () => {
  it("maps every command kind to the matching broker method", async () => {
    const { broker, calls } = makeRecordingBroker();
    const commands: MirrorCommand[] = [
      { kind: "placeOrder", request: sampleOrder },
      { kind: "requestClosePosition", symbol: "NQ" },
      { kind: "flattenPosition", symbol: "NQ", side: "short", quantity: 1 },
      { kind: "placeTrailingStop", symbol: "NQ", side: "short", quantity: 1, trailTicks: 8 },
      { kind: "placeTakeProfitOrder", symbol: "NQ", side: "short", quantity: 1, limitPrice: new Decimal(19900) },
      { kind: "cancelRestingOrder", symbol: "NQ" },
    ];
    for (const cmd of commands) await applyMirrorCommand(broker, cmd);

    expect(calls.map((c) => c.method)).toEqual([
      "placeOrder",
      "requestClosePosition",
      "flattenPosition",
      "placeTrailingStop",
      "placeTakeProfitOrder",
      "cancelRestingOrder",
    ]);
  });

  it("throws if the broker lacks an optional method the command needs", async () => {
    const { broker } = makeRecordingBroker();
    delete broker.placeTrailingStop;
    await expect(applyMirrorCommand(broker, { kind: "placeTrailingStop", symbol: "NQ", side: "long", quantity: 1, trailTicks: 5 })).rejects.toThrow(
      /does not implement placeTrailingStop/,
    );
  });
});
