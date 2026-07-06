import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { buildContractPattern, computeBracketDollars } from "../src/browserControl/pure.js";

describe("buildContractPattern", () => {
  it("matches a real CME contract code for the given prefix", () => {
    const pattern = buildContractPattern("MNQ");
    expect(pattern.test("MNQU26")).toBe(true);
    expect(pattern.test("mnqu26")).toBe(true);
  });

  it("does not match a different prefix or a malformed code", () => {
    const pattern = buildContractPattern("MNQ");
    expect(pattern.test("MESU26")).toBe(false);
    expect(pattern.test("MNQ")).toBe(false);
    expect(pattern.test("MNQU2026")).toBe(false);
  });
});

describe("computeBracketDollars", () => {
  it("computes the dollar risk/profit for a long setup", () => {
    const result = computeBracketDollars(new Decimal(20000), new Decimal(19990), new Decimal(20020), 2, new Decimal(2));
    // 10 points stop * $2/point * 2 contracts = $40 risk; 20 points target * $2 * 2 = $80 profit
    expect(result.riskDollars).toBe(40);
    expect(result.profitDollars).toBe(80);
  });

  it("computes the dollar risk/profit for a short setup (stop above entry)", () => {
    const result = computeBracketDollars(new Decimal(20000), new Decimal(20010), new Decimal(19980), 1, new Decimal(2));
    expect(result.riskDollars).toBe(20);
    expect(result.profitDollars).toBe(40);
  });

  it("returns a null profitDollars when no take-profit price is given", () => {
    const result = computeBracketDollars(new Decimal(20000), new Decimal(19990), null, 1, new Decimal(2));
    expect(result.profitDollars).toBeNull();
  });

  it("never returns a risk/profit of zero even for a tiny stop distance", () => {
    const result = computeBracketDollars(new Decimal(20000), new Decimal(20000.01), new Decimal(20000.02), 1, new Decimal(0.001));
    expect(result.riskDollars).toBeGreaterThanOrEqual(1);
    expect(result.profitDollars).toBeGreaterThanOrEqual(1);
  });
});
