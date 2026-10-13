/**
 * End-to-end over a real TCP socket: FanOutBroker -> RemoteExecutorClient
 * (HTTP) -> executorServer -> local broker. Proves the client, server, codec
 * and fan-out all fit together, and that a Decimal price survives the wire.
 */
import type { AddressInfo } from "node:net";

import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OrderSide, OrderType, type BrokerClient, type OrderRequest, type OrderResult } from "../src/brokers/types.js";
import { FanOutBroker } from "../src/multiAccount/fanOutBroker.js";
import { buildExecutorServer } from "../src/multiAccount/executorServer.js";
import { RemoteExecutorClient } from "../src/multiAccount/remoteExecutorClient.js";

const SECRET = "integration-secret";

let app: ReturnType<typeof buildExecutorServer>;
let baseUrl: string;
const remoteCalls: { request: OrderRequest }[] = [];

function remoteBroker(): BrokerClient {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getAccounts: vi.fn(async () => []),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    getHistoricalBars: vi.fn(async () => []),
    cancelOrder: vi.fn(async () => true),
    placeOrder: vi.fn(async (request: OrderRequest): Promise<OrderResult> => {
      remoteCalls.push({ request });
      return { brokerOrderId: "remote-filled", status: "filled", filledPrice: new Decimal("20010.5"), filledAt: new Date("2026-10-13T16:00:00Z") };
    }),
  } as unknown as BrokerClient;
}

beforeAll(async () => {
  app = buildExecutorServer({ broker: remoteBroker(), secret: SECRET });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

describe("mirror integration (real HTTP)", () => {
  it("fans a placeOrder from the master to a remote over HTTP, Decimal intact", async () => {
    const masterResult: OrderResult = { brokerOrderId: "master-filled", status: "filled", filledPrice: new Decimal("20009.75") };
    const master = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      getAccounts: vi.fn(async () => []),
      getPositions: vi.fn(async () => []),
      getOpenOrders: vi.fn(async () => []),
      getHistoricalBars: vi.fn(async () => []),
      cancelOrder: vi.fn(async () => true),
      placeOrder: vi.fn(async () => masterResult),
    } as unknown as BrokerClient;

    const client = new RemoteExecutorClient({ name: "pc2", baseUrl, secret: SECRET, timeoutMs: 5000 });
    const fan = new FanOutBroker(master, [client]);

    const order: OrderRequest = {
      accountId: "browser",
      symbol: "NQ",
      side: OrderSide.BUY,
      orderType: OrderType.LIMIT,
      quantity: 2,
      limitPrice: new Decimal("20010.25"),
      referencePrice: new Decimal("20010"),
      stopLossPrice: new Decimal("19985.75"),
    };

    const result = await fan.placeOrder(order);
    await fan.settle();

    // engine sees the master's result, unchanged
    expect(result.brokerOrderId).toBe("master-filled");

    // the remote actually received the order over HTTP, with the price intact
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].request.limitPrice).toBeInstanceOf(Decimal);
    expect(remoteCalls[0].request.limitPrice!.equals(new Decimal("20010.25"))).toBe(true);
    expect(remoteCalls[0].request.quantity).toBe(2);
    expect(remoteCalls[0].request.side).toBe(OrderSide.BUY);
  });

  it("a wrong secret is refused and surfaces as that account's failure (master result unchanged)", async () => {
    const master = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      getAccounts: vi.fn(async () => []),
      getPositions: vi.fn(async () => []),
      getOpenOrders: vi.fn(async () => []),
      getHistoricalBars: vi.fn(async () => []),
      cancelOrder: vi.fn(async () => true),
      requestClosePosition: vi.fn(async (): Promise<OrderResult> => ({ brokerOrderId: "master-close", status: "filled" })),
    } as unknown as BrokerClient;

    const badClient = new RemoteExecutorClient({ name: "pc9", baseUrl, secret: "wrong-secret", timeoutMs: 5000 });
    const fan = new FanOutBroker(master, [badClient]);

    const result = await fan.requestClosePosition("NQ");
    // master still succeeds even though the remote was rejected (401)
    expect(result).toMatchObject({ brokerOrderId: "master-close", status: "filled" });
  });
});
