import { afterEach, describe, expect, it } from "vitest";

import { BrowserControlBroker, getBroker } from "../src/brokers/index.js";
import { BrokerKind } from "../src/core/config.js";
import { FanOutBroker } from "../src/multiAccount/fanOutBroker.js";

const KEYS = ["MIRROR_SECRET", "MIRROR_EXECUTORS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getBroker multi-account wrapping", () => {
  it("returns the plain broker when no mirror targets are configured", async () => {
    delete process.env.MIRROR_EXECUTORS;
    delete process.env.MIRROR_SECRET;
    const broker = await getBroker(BrokerKind.BROWSER_CONTROL);
    expect(broker).toBeInstanceOf(BrowserControlBroker);
  });

  it("wraps browser_control in FanOutBroker when targets are configured", async () => {
    process.env.MIRROR_SECRET = "test-secret";
    process.env.MIRROR_EXECUTORS = "pc2=http://127.0.0.1:1";
    const broker = await getBroker(BrokerKind.BROWSER_CONTROL);
    expect(broker).toBeInstanceOf(FanOutBroker);
  });

  it("mirror:false opts out (what the executor service uses)", async () => {
    process.env.MIRROR_SECRET = "test-secret";
    process.env.MIRROR_EXECUTORS = "pc2=http://127.0.0.1:1";
    const broker = await getBroker(BrokerKind.BROWSER_CONTROL, { mirror: false });
    expect(broker).toBeInstanceOf(BrowserControlBroker);
  });

  it("refuses to fan out without a secret", async () => {
    delete process.env.MIRROR_SECRET;
    process.env.MIRROR_EXECUTORS = "pc2=http://127.0.0.1:1";
    await expect(getBroker(BrokerKind.BROWSER_CONTROL)).rejects.toThrow(/MIRROR_SECRET/);
  });

  it("never wraps the simulated broker", async () => {
    process.env.MIRROR_SECRET = "test-secret";
    process.env.MIRROR_EXECUTORS = "pc2=http://127.0.0.1:1";
    const broker = await getBroker(BrokerKind.SIMULATED);
    expect(broker).not.toBeInstanceOf(FanOutBroker);
  });
});
