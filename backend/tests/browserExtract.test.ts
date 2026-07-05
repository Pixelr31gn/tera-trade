import { describe, expect, it } from "vitest";
import { extractAccountSnapshot, extractPriceForSymbol, parseMoney } from "../src/browserWatch/extract.js";

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
  });

  it("synthesizes equity as balance + unrealized P&L when there's an open position", () => {
    const pageText = "BAL: $50,000.00\nUP&L: $325.50";
    const snapshot = extractAccountSnapshot(pageText);
    expect(snapshot.equity).toBeCloseTo(50325.5);
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
});
