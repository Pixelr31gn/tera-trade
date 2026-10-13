import { describe, expect, it, vi } from "vitest";

import { FanOutBroker } from "../src/multiAccount/fanOutBroker.js";
import type { MirrorCommand, RemoteExecutor } from "../src/multiAccount/fanOutTypes.js";
import { OrderSide, OrderType, type BrokerClient, type OrderResult } from "../src/brokers/types.js";

const ok: OrderResult = { brokerOrderId: "m", status: "filled" };

function master(): BrokerClient {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getAccounts: vi.fn(async () => []),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => []),
    getHistoricalBars: vi.fn(async () => []),
    cancelOrder: vi.fn(async () => true),
    placeOrder: vi.fn(async () => ok),
    flattenPosition: vi.fn(async () => ok),
    requestClosePosition: vi.fn(async () => ok),
  } as unknown as BrokerClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FanOutBroker — command ordering per executor", () => {
  it("a slow first command finishes before the next one STARTS on the same remote", async () => {
    const events: string[] = [];
    const slowFirst: RemoteExecutor = {
      name: "pc2",
      dispatch: async (cmd: MirrorCommand) => {
        events.push(`start:${cmd.kind}`);
        if (cmd.kind === "flattenPosition") await sleep(40);
        events.push(`end:${cmd.kind}`);
        return ok;
      },
    };
    const fan = new FanOutBroker(master(), [slowFirst]);

    // contract switch: close the MNQ position, then enter MES, issued back-to-back
    const closeP = fan.flattenPosition("NQ", "long", 1);
    const openP = fan.placeOrder({
      accountId: "browser",
      symbol: "ES",
      side: OrderSide.BUY,
      orderType: OrderType.MARKET,
      quantity: 1,
    });
    await Promise.all([closeP, openP]);
    await fan.settle();

    expect(events).toEqual(["start:flattenPosition", "end:flattenPosition", "start:placeOrder", "end:placeOrder"]);
  });

  it("a failed command does not block the commands queued behind it", async () => {
    const seen: string[] = [];
    const flaky: RemoteExecutor = {
      name: "pc2",
      dispatch: async (cmd: MirrorCommand) => {
        seen.push(cmd.kind);
        if (cmd.kind === "flattenPosition") throw new Error("timeout");
        return ok;
      },
    };
    const fan = new FanOutBroker(master(), [flaky]);

    await fan.flattenPosition("NQ", "long", 1);
    await fan.requestClosePosition("ES");
    await fan.settle();

    expect(seen).toEqual(["flattenPosition", "requestClosePosition"]);
  });

  it("each remote has its own queue — a slow pc2 does not delay pc3", async () => {
    const startedAt: Record<string, number> = {};
    const t0 = Date.now();
    const mk = (name: string, delayMs: number): RemoteExecutor => ({
      name,
      dispatch: async () => {
        startedAt[name] = Date.now() - t0;
        await sleep(delayMs);
        return ok;
      },
    });
    const fan = new FanOutBroker(master(), [mk("pc2", 60), mk("pc3", 0)]);

    await fan.requestClosePosition("NQ");
    await fan.settle();

    expect(startedAt.pc3).toBeLessThan(40);
  });

  it("the master result is returned without waiting for a slow remote", async () => {
    const slow: RemoteExecutor = {
      name: "pc2",
      dispatch: async () => {
        await sleep(300);
        return ok;
      },
    };
    const fan = new FanOutBroker(master(), [slow]);

    const t0 = Date.now();
    const result = await fan.requestClosePosition("NQ");
    const elapsed = Date.now() - t0;

    expect(result.status).toBe("filled");
    expect(elapsed).toBeLessThan(150);
    await fan.settle();
  });
});
