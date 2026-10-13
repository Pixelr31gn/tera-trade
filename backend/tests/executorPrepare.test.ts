import { describe, expect, it, vi } from "vitest";

import type { BrokerClient } from "../src/brokers/types.js";
import { buildExecutorServer } from "../src/multiAccount/executorServer.js";

const SECRET = "prep-secret";
const broker = {} as unknown as BrokerClient;

describe("executor /prepare", () => {
  it("rejects a missing or wrong secret (401) and never calls prepare", async () => {
    const prepare = vi.fn(async () => ({ ok: true }));
    const app = buildExecutorServer({ broker, secret: SECRET, prepare });
    const none = await app.inject({ method: "POST", url: "/prepare", payload: { symbol: "ES" } });
    const wrong = await app.inject({ method: "POST", url: "/prepare", headers: { "x-mirror-secret": "nope" }, payload: { symbol: "ES" } });
    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("calls prepare with the symbol and returns its report", async () => {
    const prepare = vi.fn(async () => ({ ok: true, contract: "MESZ26", quantity: "10" }));
    const app = buildExecutorServer({ broker, secret: SECRET, prepare });
    const res = await app.inject({ method: "POST", url: "/prepare", headers: { "x-mirror-secret": SECRET }, payload: { symbol: "ES" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, contract: "MESZ26", quantity: "10" });
    expect(prepare).toHaveBeenCalledWith("ES");
    await app.close();
  });

  it("returns 400 for a bad body and 501 when the executor has no prepare", async () => {
    const withPrep = buildExecutorServer({ broker, secret: SECRET, prepare: async () => ({ ok: true }) });
    const bad = await withPrep.inject({ method: "POST", url: "/prepare", headers: { "x-mirror-secret": SECRET }, payload: {} });
    expect(bad.statusCode).toBe(400);
    await withPrep.close();

    const without = buildExecutorServer({ broker, secret: SECRET });
    const none = await without.inject({ method: "POST", url: "/prepare", headers: { "x-mirror-secret": SECRET }, payload: { symbol: "ES" } });
    expect(none.statusCode).toBe(501);
    await without.close();
  });

  it("returns 500 when prepare throws", async () => {
    const app = buildExecutorServer({
      broker,
      secret: SECRET,
      prepare: async () => {
        throw new Error("boom");
      },
    });
    const res = await app.inject({ method: "POST", url: "/prepare", headers: { "x-mirror-secret": SECRET }, payload: { symbol: "ES" } });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
