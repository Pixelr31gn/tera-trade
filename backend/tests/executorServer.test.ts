import { describe, expect, it, vi } from "vitest";

import type { BrokerClient, OrderResult } from "../src/brokers/types.js";
import { buildExecutorServer } from "../src/multiAccount/executorServer.js";

const SECRET = "test-secret-123";

function fakeBroker(overrides: Partial<BrokerClient> = {}): { broker: BrokerClient; calls: string[] } {
  const calls: string[] = [];
  const ok: OrderResult = { brokerOrderId: "local-1", status: "filled" };
  const broker = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getAccounts: vi.fn(async () => []),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    getHistoricalBars: vi.fn(async () => []),
    cancelOrder: vi.fn(async () => true),
    placeOrder: vi.fn(async () => {
      calls.push("placeOrder");
      return ok;
    }),
    requestClosePosition: vi.fn(async () => {
      calls.push("requestClosePosition");
      return ok;
    }),
    ...overrides,
  } as unknown as BrokerClient;
  return { broker, calls };
}

describe("executorServer", () => {
  it("rejects a request with no secret (401)", async () => {
    const { broker, calls } = fakeBroker();
    const app = buildExecutorServer({ broker, secret: SECRET });
    const res = await app.inject({ method: "POST", url: "/mirror", payload: { kind: "requestClosePosition", symbol: "NQ" } });
    expect(res.statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("rejects a wrong secret (401)", async () => {
    const { broker } = fakeBroker();
    const app = buildExecutorServer({ broker, secret: SECRET });
    const res = await app.inject({
      method: "POST",
      url: "/mirror",
      headers: { "x-mirror-secret": "wrong" },
      payload: { kind: "requestClosePosition", symbol: "NQ" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("applies a valid command to the local broker and returns its result", async () => {
    const { broker, calls } = fakeBroker();
    const app = buildExecutorServer({ broker, secret: SECRET });
    const res = await app.inject({
      method: "POST",
      url: "/mirror",
      headers: { "x-mirror-secret": SECRET },
      payload: { kind: "requestClosePosition", symbol: "NQ" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ brokerOrderId: "local-1", status: "filled" });
    expect(calls).toEqual(["requestClosePosition"]);
    await app.close();
  });

  it("returns 400 on a malformed command", async () => {
    const { broker } = fakeBroker();
    const app = buildExecutorServer({ broker, secret: SECRET });
    const res = await app.inject({
      method: "POST",
      url: "/mirror",
      headers: { "x-mirror-secret": SECRET },
      payload: { kind: "notACommand" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 500 when the broker throws (never a silent success)", async () => {
    const { broker } = fakeBroker({
      requestClosePosition: vi.fn(async () => {
        throw new Error("broker boom");
      }),
    });
    const app = buildExecutorServer({ broker, secret: SECRET });
    const res = await app.inject({
      method: "POST",
      url: "/mirror",
      headers: { "x-mirror-secret": SECRET },
      payload: { kind: "requestClosePosition", symbol: "NQ" },
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it("health check responds ok", async () => {
    const { broker } = fakeBroker();
    const app = buildExecutorServer({ broker, secret: SECRET });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
