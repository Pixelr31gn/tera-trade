import { describe, expect, it } from "vitest";
import {
  computeVolumeDelta,
  extractAccountSnapshot,
  extractActiveAccountIdentity,
  extractPriceForSymbol,
  extractVolumeForSymbol,
  parseMoney,
} from "../src/browserWatch/extract.js";

describe("parseMoney", () => {
  it("parses plain and dollar-prefixed amounts", () => {
    expect(parseMoney("1234.56")).toBeCloseTo(1234.56);
    expect(parseMoney("$1,234.56")).toBeCloseTo(1234.56);
  });

  it("parses accounting-style negatives in parentheses", () => {
    expect(parseMoney("($500.00)")).toBeCloseTo(-500);
  });

  it("parses a leading-minus negative", () => {
    expect(parseMoney("-$250.75")).toBeCloseTo(-250.75);
  });

  it("returns null for non-numeric text", () => {
    expect(parseMoney("Available")).toBeNull();
  });
});

describe("extractAccountSnapshot", () => {
  it("finds balance/equity/pnl on a label line followed by a value line", () => {
    const pageText = [
      "Account Summary",
      "Account Balance",
      "$50,432.10",
      "Net Liquidation",
      "$50,988.25",
      "Open P&L",
      "$556.15",
    ].join("\n");

    const snapshot = extractAccountSnapshot(pageText);
    expect(snapshot.balance).toBeCloseTo(50432.1);
    expect(snapshot.equity).toBeCloseTo(50988.25);
    expect(snapshot.pnl).toBeCloseTo(556.15);
  });

  it("finds a value on the same line as its label", () => {
    const pageText = "Balance: $12,000.00\nEquity: $12,050.00";
    const snapshot = extractAccountSnapshot(pageText);
    expect(snapshot.balance).toBeCloseTo(12000);
    expect(snapshot.equity).toBeCloseTo(12050);
  });

  it("returns nulls when no matching label is present", () => {
    const snapshot = extractAccountSnapshot("Welcome to the platform\nNothing useful here");
    expect(snapshot.balance).toBeNull();
    expect(snapshot.equity).toBeNull();
    expect(snapshot.pnl).toBeNull();
  });

  it("handles a negative open P&L in parentheses", () => {
    const pageText = "Open P&L\n($123.45)";
    const snapshot = extractAccountSnapshot(pageText);
    expect(snapshot.pnl).toBeCloseTo(-123.45);
  });

  it("reads TopstepX's actual compact HUD notation (BAL/UP&L, no separate equity label)", () => {
    // Captured verbatim from a real TopstepX account page.
    const pageText = ["$50K TRADING COMBINE|50KTC-V2-170199-40086833", "BAL: $50,000.00", "MLL: $48,000.00", "RP&L: $0.00", "UP&L: $0.00"].join(
      "\n"
    );
    const snapshot = extractAccountSnapshot(pageText);
    expect(snapshot.balance).toBeCloseTo(50000);
    expect(snapshot.pnl).toBeCloseTo(0); // UP&L
    expect(snapshot.equity).toBeCloseTo(50000); // synthesized: no explicit equity label on this page
    expect(snapshot.accountName).toBe("$50K TRADING COMBINE");
    expect(snapshot.brokerAccountId).toBe("50KTC-V2-170199-40086833");
  });

  it("synthesizes equity as balance + unrealized P&L when there's an open position", () => {
    const pageText = "BAL: $50,000.00\nUP&L: $325.50";
    const snapshot = extractAccountSnapshot(pageText);
    expect(snapshot.equity).toBeCloseTo(50325.5);
  });
});

describe("extractActiveAccountIdentity", () => {
  it("reads the newer format with a trailing eligibility status", () => {
    // Captured verbatim 2026-07-21 -- the exact incident that motivated
    // per-account equity-curve separation (three real accounts were being
    // blended into one curve).
    const pageText = ["50K DLL COMBINE|50KTC-V2-DLL-170199-51281387 (Ineligible)", "BAL: $49,959.92"].join("\n");
    const identity = extractActiveAccountIdentity(pageText);
    expect(identity?.name).toBe("50K DLL COMBINE");
    expect(identity?.brokerAccountId).toBe("50KTC-V2-DLL-170199-51281387");
  });

  it("reads the older format with no eligibility status suffix", () => {
    const pageText = "$50K TRADING COMBINE|50KTC-V2-170199-40086833\nBAL: $50,000.00";
    const identity = extractActiveAccountIdentity(pageText);
    expect(identity?.name).toBe("$50K TRADING COMBINE");
    expect(identity?.brokerAccountId).toBe("50KTC-V2-170199-40086833");
  });

  it("picks the first matching account line when it appears multiple times on the page", () => {
    const pageText = [
      "50K DLL COMBINE|50KTC-V2-DLL-170199-51281387 (Ineligible)",
      "BAL: $49,959.92",
      "50K DLL COMBINE|50KTC-V2-DLL-170199-51281387 (Ineligible)", // repeated in a second widget, same account
    ].join("\n");
    const identity = extractActiveAccountIdentity(pageText);
    expect(identity?.brokerAccountId).toBe("50KTC-V2-DLL-170199-51281387");
  });

  it("returns null when no account identity line is present", () => {
    expect(extractActiveAccountIdentity("Welcome to the platform\nNothing useful here")).toBeNull();
  });
});

describe("extractPriceForSymbol", () => {
  it("finds a decimal price near the symbol label", () => {
    const pageText = ["Watchlist", "ES", "5123.25", "NQ", "17890.50"].join("\n");
    expect(extractPriceForSymbol(pageText, "ES")).toBeCloseTo(5123.25);
    expect(extractPriceForSymbol(pageText, "NQ")).toBeCloseTo(17890.5);
  });

  it("matches via a configured alias", () => {
    const pageText = "E-mini S&P 500\n5150.75";
    expect(extractPriceForSymbol(pageText, "ES", ["e-mini s&p 500"])).toBeCloseTo(5150.75);
  });

  it("returns null when the symbol isn't present", () => {
    expect(extractPriceForSymbol("Some unrelated page text", "ES")).toBeNull();
  });

  it("matches TopstepX's real contract-code quote table (ESU26/NQU26) and skips the Time and Sales false-positive trap", () => {
    // "Time and Sales" contains "es" (from "sal-es") and appears before the
    // real quote row in TopstepX's actual page -- this used to make the
    // bare substring search give up right there and return null.
    const pageText = [
      "Time and Sales",
      "...",
      "Contract",
      "Last",
      "Change",
      "ESU26",
      "7,557.00",
      "28.75",
      "NQU26",
      "29,901.75",
      "345.75",
    ].join("\n");

    expect(extractPriceForSymbol(pageText, "ES")).toBeCloseTo(7557.0);
    expect(extractPriceForSymbol(pageText, "NQ")).toBeCloseTo(29901.75);
  });

  it("ignores a stale 'Order Filled' toast and still finds the real quote price (2026-07-15 incident)", () => {
    // Real incident: a stuck Toastify "Order Filled" notification for a
    // closed MNQU26 trade lingered in the page for 30+ minutes. "MNQU26"
    // contains the substring "nq", so the loose fallback search matched the
    // toast's body before ever reaching the real "NQ" quote line below it,
    // and froze the recorded price at the toast's old fill price instead.
    const pageText = ["Order Filled", "-2 MNQU26 Market", "Execute Price: 29,624.00", "53.33%", "Watchlist", "NQ", "29,708.25"].join(
      "\n"
    );

    expect(extractPriceForSymbol(pageText, "NQ")).toBeCloseTo(29708.25);
  });

  it("returns null (not a stale toast price) when a toast is the only 'nq'-matching text on the page", () => {
    const pageText = ["Order Filled", "-2 MNQU26 Market", "Execute Price: 29,624.00", "53.33%"].join("\n");
    expect(extractPriceForSymbol(pageText, "NQ")).toBeNull();
  });
});

describe("extractVolumeForSymbol", () => {
  it("reads the Volume column from a TopstepX-style quote row", () => {
    const pageText = [
      "Contract",
      "Last",
      "Change",
      "% Chg",
      "Open",
      "Bid",
      "Ask",
      "High",
      "Low",
      "Volume",
      "Remove",
      "ESU26",
      "7,557.00",
      "28.75",
      "0.38%",
      "7,523.75",
      "7,556.50",
      "7,557.50",
      "7,565.25",
      "7,523.75",
      "125,430",
      "NQU26",
      "29,901.75",
      "345.75",
      "1.17%",
      "29,566.00",
      "29,896.50",
      "29,922.25",
      "29,955.25",
      "29,522.00",
      "98,210",
    ].join("\n");

    expect(extractVolumeForSymbol(pageText, "ES")).toBe(125430);
    expect(extractVolumeForSymbol(pageText, "NQ")).toBe(98210);
  });

  it("returns null when there's no volume figure for that row", () => {
    const pageText = "ESU26\n7,557.00\n28.75";
    expect(extractVolumeForSymbol(pageText, "ES")).toBeNull();
  });

  it("still reads the real Volume column with a stale order-filled toast sitting just above the quote table", () => {
    const pageText = [
      "Order Filled",
      "-2 MNQU26 Market",
      "Execute Price: 29,624.00",
      "53.33%",
      "Contract",
      "Last",
      "Change",
      "% Chg",
      "Open",
      "Bid",
      "Ask",
      "High",
      "Low",
      "Volume",
      "Remove",
      "NQU26",
      "29,901.75",
      "345.75",
      "1.17%",
      "29,566.00",
      "29,896.50",
      "29,922.25",
      "29,955.25",
      "29,522.00",
      "98,210",
    ].join("\n");

    expect(extractVolumeForSymbol(pageText, "NQ")).toBe(98210);
  });
});

describe("computeVolumeDelta", () => {
  it("returns 0 on the first observation (no prior reading)", () => {
    expect(computeVolumeDelta(null, 125430)).toBe(0);
  });

  it("returns the difference between consecutive cumulative readings", () => {
    expect(computeVolumeDelta(125430, 125900)).toBe(470);
  });

  it("returns 0 (not a negative spike) on an apparent session rollover", () => {
    expect(computeVolumeDelta(125430, 50)).toBe(0);
  });

  it("returns 0 when volume hasn't changed", () => {
    expect(computeVolumeDelta(125430, 125430)).toBe(0);
  });
});
