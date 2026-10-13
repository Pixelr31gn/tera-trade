/**
 * JSON-safe encode/decode for MirrorCommand and OrderResult, so a command can
 * cross HTTP between the master and a remote executor without losing precision
 * or type.
 *
 * Money values are decimal.js `Decimal` (CLAUDE.md invariant 4) -- they are
 * carried as strings, never JS numbers, so no float rounding ever touches a
 * price. Dates cross as ISO strings. Counts (quantity, trailTicks) are genuine
 * integers and stay numbers.
 *
 * This is deliberately explicit per field rather than a generic reflective
 * walker: a price silently decoded as a number instead of a Decimal is exactly
 * the class of bug the invariant exists to prevent, so each field is named.
 */
import { Decimal } from "decimal.js";

import type { OrderRequest, OrderResult } from "../brokers/types.js";
import { OrderSide, OrderType } from "../brokers/types.js";
import type { MirrorCommand } from "./fanOutTypes.js";

// ---- primitives ------------------------------------------------------------

function encDecimal(d: Decimal): string {
  return d.toString();
}
function decDecimal(v: unknown, field: string): Decimal {
  if (typeof v !== "string") throw new Error(`expected decimal string for ${field}, got ${typeof v}`);
  return new Decimal(v);
}
function encOptDecimal(d: Decimal | undefined): string | undefined {
  return d === undefined ? undefined : d.toString();
}
function decOptDecimal(v: unknown, field: string): Decimal | undefined {
  return v === undefined || v === null ? undefined : decDecimal(v, field);
}

// ---- OrderRequest ----------------------------------------------------------

export function encodeOrderRequest(r: OrderRequest): Record<string, unknown> {
  return {
    accountId: r.accountId,
    symbol: r.symbol,
    side: r.side,
    orderType: r.orderType,
    quantity: r.quantity,
    limitPrice: encOptDecimal(r.limitPrice),
    stopPrice: encOptDecimal(r.stopPrice),
    trailTicks: r.trailTicks,
    stopLossPrice: encOptDecimal(r.stopLossPrice),
    takeProfitPrice: encOptDecimal(r.takeProfitPrice),
    customTag: r.customTag,
    referencePrice: encOptDecimal(r.referencePrice),
  };
}

export function decodeOrderRequest(o: Record<string, unknown>): OrderRequest {
  const side = o.side;
  if (side !== OrderSide.BUY && side !== OrderSide.SELL) throw new Error(`bad side: ${String(side)}`);
  const orderType = o.orderType;
  if (orderType !== OrderType.MARKET && orderType !== OrderType.LIMIT && orderType !== OrderType.STOP && orderType !== OrderType.TRAILING_STOP) {
    throw new Error(`bad orderType: ${String(orderType)}`);
  }
  if (typeof o.quantity !== "number") throw new Error("quantity must be a number");
  return {
    accountId: String(o.accountId),
    symbol: String(o.symbol),
    side,
    orderType,
    quantity: o.quantity,
    limitPrice: decOptDecimal(o.limitPrice, "limitPrice"),
    stopPrice: decOptDecimal(o.stopPrice, "stopPrice"),
    trailTicks: o.trailTicks === undefined || o.trailTicks === null ? undefined : Number(o.trailTicks),
    stopLossPrice: decOptDecimal(o.stopLossPrice, "stopLossPrice"),
    takeProfitPrice: decOptDecimal(o.takeProfitPrice, "takeProfitPrice"),
    customTag: o.customTag === undefined || o.customTag === null ? undefined : String(o.customTag),
    referencePrice: decOptDecimal(o.referencePrice, "referencePrice"),
  };
}

// ---- MirrorCommand ---------------------------------------------------------

export function encodeCommand(cmd: MirrorCommand): Record<string, unknown> {
  switch (cmd.kind) {
    case "placeOrder":
      return { kind: cmd.kind, request: encodeOrderRequest(cmd.request) };
    case "requestClosePosition":
      return { kind: cmd.kind, symbol: cmd.symbol };
    case "flattenPosition":
      return { kind: cmd.kind, symbol: cmd.symbol, side: cmd.side, quantity: cmd.quantity };
    case "placeTrailingStop":
      return { kind: cmd.kind, symbol: cmd.symbol, side: cmd.side, quantity: cmd.quantity, trailTicks: cmd.trailTicks };
    case "placeTakeProfitOrder":
      return { kind: cmd.kind, symbol: cmd.symbol, side: cmd.side, quantity: cmd.quantity, limitPrice: encDecimal(cmd.limitPrice) };
    case "cancelRestingOrder":
      return { kind: cmd.kind, symbol: cmd.symbol };
    default: {
      const _never: never = cmd;
      throw new Error(`unhandled command: ${JSON.stringify(_never)}`);
    }
  }
}

export function decodeCommand(body: unknown): MirrorCommand {
  if (typeof body !== "object" || body === null) throw new Error("command body must be an object");
  const o = body as Record<string, unknown>;
  const side = (): "long" | "short" => {
    if (o.side !== "long" && o.side !== "short") throw new Error(`bad side: ${String(o.side)}`);
    return o.side;
  };
  const qty = (): number => {
    if (typeof o.quantity !== "number") throw new Error("quantity must be a number");
    return o.quantity;
  };
  switch (o.kind) {
    case "placeOrder":
      if (typeof o.request !== "object" || o.request === null) throw new Error("placeOrder needs a request object");
      return { kind: "placeOrder", request: decodeOrderRequest(o.request as Record<string, unknown>) };
    case "requestClosePosition":
      return { kind: "requestClosePosition", symbol: String(o.symbol) };
    case "flattenPosition":
      return { kind: "flattenPosition", symbol: String(o.symbol), side: side(), quantity: qty() };
    case "placeTrailingStop":
      if (typeof o.trailTicks !== "number") throw new Error("trailTicks must be a number");
      return { kind: "placeTrailingStop", symbol: String(o.symbol), side: side(), quantity: qty(), trailTicks: o.trailTicks };
    case "placeTakeProfitOrder":
      return { kind: "placeTakeProfitOrder", symbol: String(o.symbol), side: side(), quantity: qty(), limitPrice: decDecimal(o.limitPrice, "limitPrice") };
    case "cancelRestingOrder":
      return { kind: "cancelRestingOrder", symbol: String(o.symbol) };
    default:
      throw new Error(`unknown command kind: ${String(o.kind)}`);
  }
}

// ---- OrderResult -----------------------------------------------------------

export function encodeResult(r: OrderResult): Record<string, unknown> {
  return {
    brokerOrderId: r.brokerOrderId,
    status: r.status,
    filledPrice: encOptDecimal(r.filledPrice),
    filledAt: r.filledAt ? r.filledAt.toISOString() : undefined,
    error: r.error,
  };
}

export function decodeResult(body: unknown): OrderResult {
  if (typeof body !== "object" || body === null) throw new Error("result body must be an object");
  const o = body as Record<string, unknown>;
  if (o.status !== "filled" && o.status !== "pending" && o.status !== "rejected") {
    throw new Error(`bad result status: ${String(o.status)}`);
  }
  return {
    brokerOrderId: String(o.brokerOrderId ?? ""),
    status: o.status,
    filledPrice: decOptDecimal(o.filledPrice, "filledPrice"),
    filledAt: o.filledAt === undefined || o.filledAt === null ? undefined : new Date(String(o.filledAt)),
    error: o.error === undefined || o.error === null ? undefined : String(o.error),
  };
}
