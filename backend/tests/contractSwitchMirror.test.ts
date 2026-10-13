import { describe, expect, it, vi } from "vitest";

import { OrderSide, OrderType, type BrokerClient, type OrderResult } from "../src/brokers/types.js";
import { getInstrument } from "../src/marketData/instruments.js";
import { FanOutBroker } from "../src/multiAccount/fanOutBroker.js";
import type { MirrorCommand, RemoteExecutor } from "../src/multiAccount/fanOutTypes.js";

const ok: OrderResult = { brokerOrderId: "m", status: "filled" };

describe("switching the traded contract (MNQ -> MES)", () => {
  it("maps the engine symbols to the micro contracts each remote clicks on", () => {
    expect(getInstrument("NQ").brokerContractPrefix).toBe("MNQ");
    expect(getInstrument("ES").brokerContractPrefix).toBe("MES");
  });

  it("mirrors flatten-MNQ then enter-MES to every remote, in that order, with symbols intact", async () => {
    const master = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      getAccounts: vi.fn(async () => []),
      getPositions: vi.fn(async () => []),
      getOpenOrders: vi.fn(async () => []),
      getHistoricalBars: vi.fn(async () => []),
      cancelOrder: vi.fn(async () => true),
      placeOrder: vi.fn(async () => ok),
      flattenPosition: vi.fn(async () => ok),
    } as unknown as BrokerClient;

    const logs: Record<string, MirrorCommand[]> = { pc2: [], pc3: [] };
    const remote = (name: string, jitterMs: number): RemoteExecutor => ({
      name,
      dispatch: async (cmd) => {
        await new Promise((r) => setTimeout(r, jitterMs));
        logs[name]!.push(cmd);
        return ok;
      },
    });

    const fan = new FanOutBroker(master, [remote("pc2", 25), remote("pc3", 1)]);

    await fan.flattenPosition("NQ", "long", 1);
    await fan.placeOrder({ accountId: "browser", symbol: "ES", side: OrderSide.BUY, orderType: OrderType.MARKET, quantity: 1 });
    await fan.settle();

    for (const name of ["pc2", "pc3"]) {
      const seen = logs[name]!.map((c) => (c.kind === "placeOrder" ? `${c.kind}:${c.request.symbol}` : `${c.kind}:${c.symbol}`));
      expect(seen).toEqual(["flattenPosition:NQ", "placeOrder:ES"]);
    }
  });
});
