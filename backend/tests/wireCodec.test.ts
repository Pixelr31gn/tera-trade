import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { OrderSide, OrderType, type OrderRequest, type OrderResult } from "../src/brokers/types.js";
import { decodeCommand, decodeResult, encodeCommand, encodeResult } from "../src/multiAccount/wireCodec.js";
import type { MirrorCommand } from "../src/multiAccount/fanOutTypes.js";

// JSON round-trip, exactly as HTTP would do it (stringify + parse).
function roundTripCommand(cmd: MirrorCommand): MirrorCommand {
  return decodeCommand(JSON.parse(JSON.stringify(encodeCommand(cmd))));
}
function roundTripResult(r: OrderResult): OrderResult {
  return decodeResult(JSON.parse(JSON.stringify(encodeResult(r))));
}

const order: OrderRequest = {
  accountId: "browser",
  symbol: "NQ",
  side: OrderSide.BUY,
  orderType: OrderType.LIMIT,
  quantity: 3,
  limitPrice: new Decimal("20012.25"),
  stopLossPrice: new Decimal("19987.75"),
  takeProfitPrice: new Decimal("20099.5"),
  referencePrice: new Decimal("20010"),
  customTag: "sig-42",
};

describe("wireCodec — commands", () => {
  it("round-trips placeOrder with Decimal prices intact (as strings, no float drift)", () => {
    const out = roundTripCommand({ kind: "placeOrder", request: order });
    expect(out.kind).toBe("placeOrder");
    if (out.kind !== "placeOrder") throw new Error("kind");
    const r = out.request;
    expect(r.limitPrice).toBeInstanceOf(Decimal);
    expect(r.limitPrice!.equals(order.limitPrice!)).toBe(true);
    expect(r.stopLossPrice!.equals(order.stopLossPrice!)).toBe(true);
    expect(r.takeProfitPrice!.equals(order.takeProfitPrice!)).toBe(true);
    expect(r.referencePrice!.equals(order.referencePrice!)).toBe(true);
    expect(r.quantity).toBe(3);
    expect(r.side).toBe(OrderSide.BUY);
    expect(r.orderType).toBe(OrderType.LIMIT);
    expect(r.customTag).toBe("sig-42");
  });

  it("round-trips a high-precision price without rounding", () => {
    const precise = new Decimal("20012.123456789012345");
    const out = roundTripCommand({ kind: "placeTakeProfitOrder", symbol: "NQ", side: "long", quantity: 1, limitPrice: precise });
    if (out.kind !== "placeTakeProfitOrder") throw new Error("kind");
    expect(out.limitPrice.equals(precise)).toBe(true);
  });

  it("round-trips the plain symbol/side/qty commands", () => {
    expect(roundTripCommand({ kind: "requestClosePosition", symbol: "ES" })).toEqual({ kind: "requestClosePosition", symbol: "ES" });
    expect(roundTripCommand({ kind: "flattenPosition", symbol: "ES", side: "short", quantity: 2 })).toEqual({
      kind: "flattenPosition",
      symbol: "ES",
      side: "short",
      quantity: 2,
    });
    expect(roundTripCommand({ kind: "placeTrailingStop", symbol: "ES", side: "long", quantity: 2, trailTicks: 12 })).toEqual({
      kind: "placeTrailingStop",
      symbol: "ES",
      side: "long",
      quantity: 2,
      trailTicks: 12,
    });
    expect(roundTripCommand({ kind: "cancelRestingOrder", symbol: "ES" })).toEqual({ kind: "cancelRestingOrder", symbol: "ES" });
  });

  it("rejects an unknown command kind", () => {
    expect(() => decodeCommand({ kind: "nope" })).toThrow(/unknown command kind/);
  });
});

describe("wireCodec — results", () => {
  it("round-trips a filled result with Decimal price and Date", () => {
    const r: OrderResult = { brokerOrderId: "browser-1", status: "filled", filledPrice: new Decimal("20010.25"), filledAt: new Date("2026-10-13T15:30:00.000Z") };
    const out = roundTripResult(r);
    expect(out.status).toBe("filled");
    expect(out.filledPrice!.equals(r.filledPrice!)).toBe(true);
    expect(out.filledAt!.getTime()).toBe(r.filledAt!.getTime());
  });

  it("round-trips a rejected result with an error and no price", () => {
    const r: OrderResult = { brokerOrderId: "", status: "rejected", error: "locked out" };
    expect(roundTripResult(r)).toEqual({ brokerOrderId: "", status: "rejected", error: "locked out" });
  });

  it("rejects a bad status", () => {
    expect(() => decodeResult({ brokerOrderId: "x", status: "exploded" })).toThrow(/bad result status/);
  });
});
