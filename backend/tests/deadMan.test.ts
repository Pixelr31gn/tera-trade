import { describe, expect, it, vi } from "vitest";

import type { BrokerClient, OrderResult } from "../src/brokers/types.js";
import { DeadManSwitch, flattenAllPositions } from "../src/multiAccount/deadMan.js";

describe("DeadManSwitch", () => {
  function make(timeoutMs = 60_000) {
    let t = 1_000_000;
    const onTrip = vi.fn(async () => {});
    const dm = new DeadManSwitch({ timeoutMs, onTrip, now: () => t });
    return { dm, onTrip, advance: (ms: number) => (t += ms) };
  }

  it("never trips before the first heartbeat", () => {
    const { dm, onTrip, advance } = make();
    advance(10 * 60_000);
    dm.check();
    expect(onTrip).not.toHaveBeenCalled();
    expect(dm.isArmed()).toBe(false);
  });

  it("does not trip while heartbeats keep arriving", () => {
    const { dm, onTrip, advance } = make();
    dm.beat();
    for (let i = 0; i < 20; i++) {
      advance(10_000);
      dm.beat();
      dm.check();
    }
    expect(onTrip).not.toHaveBeenCalled();
  });

  it("trips once after the timeout of silence, not at exactly the timeout", () => {
    const { dm, onTrip, advance } = make(60_000);
    dm.beat();
    advance(60_000);
    dm.check();
    expect(onTrip).not.toHaveBeenCalled();
    advance(1);
    dm.check();
    dm.check();
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(dm.isArmed()).toBe(false);
  });

  it("re-arms on the next heartbeat and can trip again", () => {
    const { dm, onTrip, advance } = make(60_000);
    dm.beat();
    advance(61_000);
    dm.check();
    dm.beat();
    expect(dm.isArmed()).toBe(true);
    advance(61_000);
    dm.check();
    expect(onTrip).toHaveBeenCalledTimes(2);
  });

  it("a throwing onTrip never escapes the timer", async () => {
    let t = 0;
    const dm = new DeadManSwitch({
      timeoutMs: 10,
      now: () => t,
      onTrip: async () => {
        throw new Error("boom");
      },
    });
    dm.beat();
    t = 100;
    expect(() => dm.check()).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("flattenAllPositions", () => {
  const ok: OrderResult = { brokerOrderId: "x", status: "filled" };
  function broker(flatBySymbol: Record<string, boolean | null>, closeResult: OrderResult = ok) {
    const calls: string[] = [];
    const b = {
      isPositionFlat: vi.fn(async (s: string) => flatBySymbol[s] ?? null),
      requestClosePosition: vi.fn(async (s: string) => {
        calls.push(`close:${s}`);
        return closeResult;
      }),
      cancelRestingOrder: vi.fn(async (s: string) => {
        calls.push(`cancel:${s}`);
        return ok;
      }),
    } as unknown as BrokerClient;
    return { b, calls };
  }

  it("closes then cancels resting orders for a confirmed-open position, and leaves flat ones alone", async () => {
    const { b, calls } = broker({ NQ: false, ES: true });
    const report = await flattenAllPositions(b, ["ES", "NQ"], { retryDelayMs: 1 });
    expect(calls).toEqual(["close:NQ", "cancel:NQ"]);
    expect(report).toEqual({ closed: ["NQ"], alreadyFlat: ["ES"], needsAttention: [] });
  });

  it("does NOT close when the position state is unreadable -- retries, then flags it", async () => {
    const { b, calls } = broker({ NQ: null });
    const report = await flattenAllPositions(b, ["NQ"], { readRetries: 3, retryDelayMs: 1 });
    expect(calls).toEqual([]);
    expect(report.needsAttention).toEqual(["NQ"]);
    expect((b.isPositionFlat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("flags a rejected close and does not cancel the stop that is still protecting it", async () => {
    const { b, calls } = broker({ NQ: false }, { brokerOrderId: "", status: "rejected", error: "no widget" });
    const report = await flattenAllPositions(b, ["NQ"], { retryDelayMs: 1 });
    expect(calls).toEqual(["close:NQ"]);
    expect(report.needsAttention).toEqual(["NQ"]);
    expect(report.closed).toEqual([]);
  });

  it("one symbol failing does not stop the others", async () => {
    const b = {
      isPositionFlat: vi.fn(async (s: string) => {
        if (s === "ES") throw new Error("read failed");
        return false;
      }),
      requestClosePosition: vi.fn(async () => ok),
      cancelRestingOrder: vi.fn(async () => ok),
    } as unknown as BrokerClient;
    const report = await flattenAllPositions(b, ["ES", "NQ"], { retryDelayMs: 1 });
    expect(report.needsAttention).toEqual(["ES"]);
    expect(report.closed).toEqual(["NQ"]);
  });
});
