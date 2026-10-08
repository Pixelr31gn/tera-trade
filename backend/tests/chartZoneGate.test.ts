import { describe, expect, it } from "vitest";
import { chartSymbolToInstrument, type ChartZoneRead } from "../src/browserControl/chartZones.js";
import { checkChartZone } from "../src/risk/chartZoneGate.js";

function read(zones: Record<string, Array<[number, number]>>, charted: string[] = Object.keys(zones)): ChartZoneRead {
  return {
    ok: true,
    chartedSymbols: new Set(charted),
    zonesBySymbol: new Map(Object.entries(zones).map(([s, rs]) => [s, rs.map(([low, high]) => ({ low, high, chartSymbol: s }))])),
  };
}

describe("chartSymbolToInstrument", () => {
  it("maps TopstepX chart symbols to tracked instruments", () => {
    expect(chartSymbolToInstrument("MNQZ26")).toBe("NQ");
    expect(chartSymbolToInstrument("MESZ26")).toBe("ES");
    expect(chartSymbolToInstrument("NQZ26")).toBe("NQ");
    expect(chartSymbolToInstrument("MGCZ26")).toBe("GC");
    expect(chartSymbolToInstrument("CME_MINI:MNQ1!")).toBe("NQ");
    expect(chartSymbolToInstrument("ZBZ26")).toBeNull();
  });
});

describe("checkChartZone", () => {
  it("allows an entry while price is inside a rectangle (edges inclusive)", () => {
    const r = read({ NQ: [[31482.89, 31486.23]] });
    expect(checkChartZone(r, "NQ", 31484).allowed).toBe(true);
    expect(checkChartZone(r, "NQ", 31482.89).allowed).toBe(true);
    expect(checkChartZone(r, "NQ", 31486.23).allowed).toBe(true);
  });

  it("blocks outside every rectangle and names the nearest one", () => {
    const c = checkChartZone(read({ NQ: [[31482.89, 31486.23], [24875, 24921]] }), "NQ", 31500);
    expect(c.allowed).toBe(false);
    expect(c.reason).toContain("31482.89-31486.23");
  });

  it("allows inside any one of several rectangles", () => {
    expect(checkChartZone(read({ NQ: [[100, 110], [200, 210]] }), "NQ", 205).allowed).toBe(true);
  });

  it("blocks a symbol with a chart but no rectangle", () => {
    const c = checkChartZone(read({ NQ: [] }), "NQ", 31484);
    expect(c.allowed).toBe(false);
    expect(c.reason).toContain("no rectangle");
  });

  it("blocks a symbol no chart is showing", () => {
    const c = checkChartZone(read({ NQ: [[31482, 31487]] }), "ES", 7880);
    expect(c.allowed).toBe(false);
    expect(c.reason).toContain("no TopstepX chart is showing ES");
  });

  it("fails closed when the chart can't be read", () => {
    expect(checkChartZone({ ok: false, error: "tab not found" }, "NQ", 31484).allowed).toBe(false);
  });
});
