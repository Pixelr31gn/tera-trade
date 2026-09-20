import { describe, expect, it } from "vitest";
import { findMatchingClosedTrade, parseClosedTradeRow } from "../src/browserControl/tradeHistoryPanel.js";

// Captured verbatim from a real TopstepX account 2026-08-31 -- the exact
// row that motivated this file (order 3046950479, pasted directly by the
// operator from the live Trade History grid).
const REAL_ROW = {
  journal: "",
  id: "3046950479",
  contractName: "MNQU26",
  positionSize: "10",
  entryTime: "2026-08-31 12:29:44.951",
  exitedAt: "2026-08-31 12:32:26.101",
  tradeDurationDisplay: "00:02:41",
  entryPrice: "29,438.25",
  exitPrice: "29,435.75",
  pnL: "$50.00",
  commissions: "$-5.00",
  fees: "$-7.20",
  direction: "Short",
};

describe("parseClosedTradeRow", () => {
  it("parses a real captured row", () => {
    const entry = parseClosedTradeRow(REAL_ROW);
    expect(entry).not.toBeNull();
    expect(entry?.brokerTradeId).toBe("3046950479");
    expect(entry?.contractCode).toBe("MNQU26");
    expect(entry?.quantity).toBe(10);
    expect(entry?.side).toBe("short");
    expect(entry?.entryPrice.toNumber()).toBeCloseTo(29438.25);
    expect(entry?.exitPrice.toNumber()).toBeCloseTo(29435.75);
    expect(entry?.grossPnl.toNumber()).toBeCloseTo(50.0);
    expect(entry?.totalDeductions.toNumber()).toBeCloseTo(-12.2);
    // Real net realized dollar result: 50.00 - 5.00 - 7.20.
    expect(entry?.netPnl.toNumber()).toBeCloseTo(37.8);
  });

  it("parses entry/exit time in local time (no fixed UTC offset assumed)", () => {
    const entry = parseClosedTradeRow(REAL_ROW);
    const entryTime = entry!.entryTime;
    expect(entryTime.getFullYear()).toBe(2026);
    expect(entryTime.getMonth()).toBe(7); // 0-indexed -- August
    expect(entryTime.getDate()).toBe(31);
    expect(entryTime.getHours()).toBe(12);
    expect(entryTime.getMinutes()).toBe(29);
    expect(entryTime.getSeconds()).toBe(44);
    expect(entryTime.getMilliseconds()).toBe(951);
  });

  it("parses a long row with a different fee structure", () => {
    // Captured the same session -- a 5-contract trade, half the commission/
    // fee of the 10-contract row above (per-contract commission structure).
    const row = {
      id: "3047055891",
      contractName: "MESU26",
      positionSize: "5",
      entryTime: "2026-08-31 12:41:17.733",
      exitedAt: "2026-08-31 12:59:07.432",
      entryPrice: "7,683.25",
      exitPrice: "7,685.25",
      pnL: "$50.00",
      commissions: "$-2.50",
      fees: "$-3.60",
      direction: "Long",
    };
    const entry = parseClosedTradeRow(row);
    expect(entry?.side).toBe("long");
    expect(entry?.quantity).toBe(5);
    expect(entry?.netPnl.toNumber()).toBeCloseTo(43.9);
  });

  it("returns null when a required field is missing", () => {
    const { pnL: _pnL, ...withoutPnl } = REAL_ROW;
    expect(parseClosedTradeRow(withoutPnl)).toBeNull();
  });

  it("returns null when a required field doesn't parse (e.g. malformed timestamp)", () => {
    expect(parseClosedTradeRow({ ...REAL_ROW, entryTime: "not-a-timestamp" })).toBeNull();
  });

  it("returns null for an unrecognized direction value", () => {
    expect(parseClosedTradeRow({ ...REAL_ROW, direction: "Flat" })).toBeNull();
  });

  it("returns null for a zero or negative quantity", () => {
    expect(parseClosedTradeRow({ ...REAL_ROW, positionSize: "0" })).toBeNull();
  });
});

describe("findMatchingClosedTrade", () => {
  const entries = [parseClosedTradeRow(REAL_ROW)!];

  it("matches on side + quantity + close entryTime", () => {
    const trade = { side: "short", quantity: 10, entryTime: new Date(2026, 7, 31, 12, 29, 45) };
    const match = findMatchingClosedTrade(trade, entries);
    expect(match?.brokerTradeId).toBe("3046950479");
  });

  it("does not match a different side", () => {
    const trade = { side: "long", quantity: 10, entryTime: new Date(2026, 7, 31, 12, 29, 45) };
    expect(findMatchingClosedTrade(trade, entries)).toBeNull();
  });

  it("does not match a different quantity", () => {
    const trade = { side: "short", quantity: 5, entryTime: new Date(2026, 7, 31, 12, 29, 45) };
    expect(findMatchingClosedTrade(trade, entries)).toBeNull();
  });

  it("does not match when entryTime is outside the tolerance window", () => {
    const trade = { side: "short", quantity: 10, entryTime: new Date(2026, 7, 31, 12, 40, 0) };
    expect(findMatchingClosedTrade(trade, entries)).toBeNull();
  });

  it("picks the closest entryTime among several plausible candidates", () => {
    const far = { ...parseClosedTradeRow(REAL_ROW)!, brokerTradeId: "far", entryTime: new Date(2026, 7, 31, 12, 27, 0) };
    const close = { ...parseClosedTradeRow(REAL_ROW)!, brokerTradeId: "close", entryTime: new Date(2026, 7, 31, 12, 29, 40) };
    const trade = { side: "short", quantity: 10, entryTime: new Date(2026, 7, 31, 12, 29, 44) };
    const match = findMatchingClosedTrade(trade, [far, close]);
    expect(match?.brokerTradeId).toBe("close");
  });

  it("returns null against an empty entries list", () => {
    const trade = { side: "short", quantity: 10, entryTime: new Date() };
    expect(findMatchingClosedTrade(trade, [])).toBeNull();
  });

  // 2026-09-03, operator report: "the pn&l is not correct... basing the pn&l
  // based off the id" -- confirmed live via trades #234/#236, both matched
  // to the same real brokerOrderId "3063210748" (same entry price, ~3
  // minutes apart -- exactly the known TOCTOU duplicate-entry pattern) and
  // double-attributed the identical -$18.60 real fill to both.
  it("never matches a broker trade ID already claimed by another of our own trades", () => {
    const trade = { side: "short", quantity: 10, entryTime: new Date(2026, 7, 31, 12, 29, 45) };
    const match = findMatchingClosedTrade(trade, entries, new Set(["3046950479"]));
    expect(match).toBeNull();
  });

  it("still matches normally when the excluded set doesn't include this candidate", () => {
    const trade = { side: "short", quantity: 10, entryTime: new Date(2026, 7, 31, 12, 29, 45) };
    const match = findMatchingClosedTrade(trade, entries, new Set(["some-other-id"]));
    expect(match?.brokerTradeId).toBe("3046950479");
  });

  it("falls through to the next-closest candidate once the closer one is already claimed", () => {
    const far = { ...parseClosedTradeRow(REAL_ROW)!, brokerTradeId: "far", entryTime: new Date(2026, 7, 31, 12, 27, 0) };
    const close = { ...parseClosedTradeRow(REAL_ROW)!, brokerTradeId: "close", entryTime: new Date(2026, 7, 31, 12, 29, 40) };
    const trade = { side: "short", quantity: 10, entryTime: new Date(2026, 7, 31, 12, 29, 44) };
    const match = findMatchingClosedTrade(trade, [far, close], new Set(["close"]));
    expect(match?.brokerTradeId).toBe("far");
  });
});
