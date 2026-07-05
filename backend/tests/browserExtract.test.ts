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
});
