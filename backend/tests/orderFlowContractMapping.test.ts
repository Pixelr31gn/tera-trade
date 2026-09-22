import { describe, expect, it } from "vitest";
import { DEFAULT_INSTRUMENTS } from "../src/marketData/instruments.js";
import { __orderFlowMappingInternals } from "../src/browserWatch/orderFlowListener.js";

const { contractRootToSymbol, globexCodeToSymbol } = __orderFlowMappingInternals;

/**
 * 2026-09-21. The order-flow listener's contract map held only the FULL-SIZE
 * E-mini roots ("F.US.EP", "F.US.ENQ") while the account has traded the micro
 * contracts since 2026-07-06. Every RealTimeDom and trade-log frame for
 * MES/MNQ resolved to null and was dropped, so getLatestOrderFlowSnapshot
 * returned nothing on every signal and v3's order-flow adjustment and v5
 * scored without it -- for two months, behind a single warning per process
 * that nothing could read until logs went to a file.
 *
 * The regression test that matters is not "MES maps now" but "every
 * instrument the registry declares resolves," which is what hand-listing
 * failed to keep true.
 */
describe("order-flow contract mapping", () => {
  it("resolves the contract root of every instrument in the registry", () => {
    for (const i of DEFAULT_INSTRUMENTS) {
      expect(contractRootToSymbol(`F.US.${i.brokerContractPrefix}`), i.symbol).toBe(i.symbol);
    }
  });

  it("resolves the two roots actually seen dropped in live traffic", () => {
    expect(contractRootToSymbol("F.US.MNQ")).toBe("NQ");
    expect(contractRootToSymbol("F.US.MES")).toBe("ES");
  });

  it("still resolves the full-size roots, so switching back off micros works", () => {
    expect(contractRootToSymbol("F.US.EP")).toBe("ES");
    expect(contractRootToSymbol("F.US.ENQ")).toBe("NQ");
  });

  it("strips the CON. prefix and the trailing month/year segment", () => {
    expect(contractRootToSymbol("CON.F.US.MNQ.U26")).toBe("NQ");
    expect(contractRootToSymbol("F.US.MNQ.Z26")).toBe("NQ");
    expect(contractRootToSymbol("CON.F.US.EP.U26")).toBe("ES");
  });

  it("returns null for a genuinely unknown root rather than guessing", () => {
    expect(contractRootToSymbol("F.US.ZZZ")).toBeNull();
    expect(contractRootToSymbol("nonsense")).toBeNull();
  });

  it("resolves Globex/Tilt codes for both contract shapes", () => {
    // Full-size, which already worked.
    expect(globexCodeToSymbol("ESU6")).toBe("ES");
    expect(globexCodeToSymbol("NQZ26")).toBe("NQ");
    // Micro, which matched the pattern and was then dropped.
    expect(globexCodeToSymbol("MESU6")).toBe("ES");
    expect(globexCodeToSymbol("MNQU6")).toBe("NQ");
    expect(globexCodeToSymbol("MGCZ26")).toBe("GC");
  });

  it("resolves a Globex code for every instrument in the registry, both shapes", () => {
    for (const i of DEFAULT_INSTRUMENTS) {
      expect(globexCodeToSymbol(`${i.symbol}U6`), i.symbol).toBe(i.symbol);
      expect(globexCodeToSymbol(`${i.brokerContractPrefix}U6`), i.brokerContractPrefix).toBe(i.symbol);
    }
  });

  it("returns null for a non-Globex string", () => {
    expect(globexCodeToSymbol("ES")).toBeNull();
    expect(globexCodeToSymbol("ESX")).toBeNull();
    expect(globexCodeToSymbol("")).toBeNull();
  });
});
