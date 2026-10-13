import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrokerClient } from "../src/brokers/types.js";
import { DeadManSwitch } from "../src/multiAccount/deadMan.js";
import { buildExecutorServer } from "../src/multiAccount/executorServer.js";
import { FanOutBroker } from "../src/multiAccount/fanOutBroker.js";
import type { RemoteExecutor } from "../src/multiAccount/fanOutTypes.js";
import { RemoteExecutorClient } from "../src/multiAccount/remoteExecutorClient.js";

const SECRET = "hb-secret";
const broker = {} as unknown as BrokerClient;

function masterBroker(): BrokerClient {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  } as unknown as BrokerClient;
}

describe("executor /heartbeat", () => {
  it("rejects a bad secret and never beats", async () => {
    const beat = vi.fn();
    const app = buildExecutorServer({ broker, secret: SECRET, deadMan: { beat, isArmed: () => false } });
    const res = await app.inject({ method: "POST", url: "/heartbeat", headers: { "x-mirror-secret": "nope" } });
    expect(res.statusCode).toBe(401);
    expect(beat).not.toHaveBeenCalled();
    await app.close();
  });

  it("beats the dead-man switch with a good secret and reports armed", async () => {
    let armed = false;
    const beat = vi.fn(() => {
      armed = true;
    });
    const app = buildExecutorServer({ broker, secret: SECRET, deadMan: { beat, isArmed: () => armed } });
    const res = await app.inject({ method: "POST", url: "/heartbeat", headers: { "x-mirror-secret": SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, armed: true });
    expect(beat).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("answers 501 when the switch is disabled", async () => {
    const app = buildExecutorServer({ broker, secret: SECRET });
    const res = await app.inject({ method: "POST", url: "/heartbeat", headers: { "x-mirror-secret": SECRET } });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});

describe("FanOutBroker heartbeats", () => {
  afterEach(() => vi.useRealTimers());

  it("beats every executor on connect and then on an interval, and stops on disconnect", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => {});
    const remote: RemoteExecutor = { name: "pc2", dispatch: vi.fn(), heartbeat } as unknown as RemoteExecutor;
    const fan = new FanOutBroker(masterBroker(), [remote], 10_000);

    await fan.connect();
    expect(heartbeat).toHaveBeenCalledTimes(1); // immediate, so the executor arms right away
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat).toHaveBeenCalledTimes(4);

    await fan.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(4); // no more after disconnect
  });

  it("a failing heartbeat to one remote never throws and does not stop the others", async () => {
    vi.useFakeTimers();
    const good = vi.fn(async () => {});
    const bad = vi.fn(async () => {
      throw new Error("network down");
    });
    const fan = new FanOutBroker(
      masterBroker(),
      [
        { name: "pc2", dispatch: vi.fn(), heartbeat: bad } as unknown as RemoteExecutor,
        { name: "pc3", dispatch: vi.fn(), heartbeat: good } as unknown as RemoteExecutor,
      ],
      10_000,
    );
    await expect(fan.connect()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(good).toHaveBeenCalledTimes(2);
    await fan.disconnect();
  });

  it("starts no timer when no executor supports heartbeats", async () => {
    vi.useFakeTimers();
    const fan = new FanOutBroker(masterBroker(), [{ name: "pc2", dispatch: vi.fn() } as unknown as RemoteExecutor]);
    await fan.connect();
    expect(vi.getTimerCount()).toBe(0);
    await fan.disconnect();
  });
});

describe("heartbeat over real HTTP", () => {
  it("a client heartbeat arms the executor's dead-man switch", async () => {
    const dm = new DeadManSwitch({ timeoutMs: 60_000, onTrip: async () => {} });
    const app = buildExecutorServer({ broker, secret: SECRET, deadMan: dm });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    expect(dm.isArmed()).toBe(false);
    const client = new RemoteExecutorClient({ name: "pc2", baseUrl: url, secret: SECRET, timeoutMs: 5000 });
    await client.heartbeat();
    expect(dm.isArmed()).toBe(true);

    const wrong = new RemoteExecutorClient({ name: "pc2", baseUrl: url, secret: "wrong", timeoutMs: 5000 });
    await expect(wrong.heartbeat()).rejects.toThrow(/401/);
    await app.close();
  });
});
