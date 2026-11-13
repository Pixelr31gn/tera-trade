import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { isExpectedDragOrder, pickPositionTagX } from "../src/browserControl/chartDrag.js";
import type { ApiOpenOrder } from "../src/browserControl/topstepApi.js";

const tick = new Decimal("0.25");
const order = (o: Partial<ApiOpenOrder>): ApiOpenOrder => ({ id: 1, type: 4, side: 1, size: 1, limitPrice: null, stopPrice: null, ...o });

describe("chart drag (2026-11-13)", () => {
  it("picks the position tag from a scanned canvas row (live scan, MES @ 7557.25)", () => {
    // Pane-relative runs seen live: the 72px tag at 513, candle bits and an 18px fragment.
    expect(pickPositionTagX([[513, 72], [557, 18], [576, 9], [120, 5]], 658)).toBe(513);
    // Nothing tag-sized -> not found (never press blind).
    expect(pickPositionTagX([[120, 5], [300, 12]], 658)).toBeNull();
    // A full-width run is the line, not a tag.
    expect(pickPositionTagX([[0, 532]], 658)).toBeNull();
  });

  it("accepts the stop/limit the operator's drags produced (live 2026-11-13)", () => {
    // Long exit stop: type 4, sell, 7531.75 when 7531.75 was asked.
    expect(isExpectedDragOrder(order({ stopPrice: 7531.75 }), { side: "long", kind: "stop", price: new Decimal("7531.75"), tickSize: tick }).matches).toBe(true);
    // Target moved to exactly 7574.25.
    expect(isExpectedDragOrder(order({ type: 1, limitPrice: 7574.25 }), { side: "long", kind: "limit", price: new Decimal("7574.25"), tickSize: tick }).matches).toBe(true);
    // One tick off from pixel snapping (7539.50 for 7539.25) is accepted.
    expect(isExpectedDragOrder(order({ stopPrice: 7539.5 }), { side: "long", kind: "stop", price: new Decimal("7539.25"), tickSize: tick }).matches).toBe(true);
  });

  it("rejects the wrong type, side, or a price more than 2 ticks off", () => {
    const want = { side: "long" as const, kind: "stop" as const, price: new Decimal("7539.25"), tickSize: tick };
    expect(isExpectedDragOrder(order({ type: 1, limitPrice: 7539.25 }), want).matches).toBe(false);
    expect(isExpectedDragOrder(order({ side: 0, stopPrice: 7539.25 }), want).matches).toBe(false);
    expect(isExpectedDragOrder(order({ stopPrice: 7540.25 }), want).matches).toBe(false);
    // A short's exit is a buy (side 0).
    expect(isExpectedDragOrder(order({ side: 0, stopPrice: 7560 }), { side: "short", kind: "stop", price: new Decimal("7560"), tickSize: tick }).matches).toBe(true);
  });
});
