import { describe, expect, it } from "vitest";
import { generateDealerLevelReport, type DealerLevelReportInput, type BucketSnapshot, type WallHistoricalStats } from "../src/analytics/dealerLevelReport.js";

function bucket(overrides: Partial<BucketSnapshot> = {}): BucketSnapshot {
  return { callWall: null, putWall: null, gammaFlip: null, callWallConfirmed: false, putWallConfirmed: false, ...overrides };
}

const NO_HISTORY: WallHistoricalStats = { touches: 0, rejected: 0, broken: 0 };

function baseInput(overrides: Partial<DealerLevelReportInput> = {}): DealerLevelReportInput {
  return {
    symbol: "NQ",
    session: "new_york",
    time: new Date("2026-08-11T18:20:00Z"),
    spotPrice: 29650,
    atrValue: 10,
    zeroDte: bucket({ callWall: 29700, putWall: 29600, gammaFlip: 29640, callWallConfirmed: false, putWallConfirmed: true }),
    structural: bucket({ callWall: 29750, putWall: 29200, gammaFlip: 29640 }),
    previousZeroDte: null,
    previousStructural: null,
    zeroDteCallWallHistory: NO_HISTORY,
    zeroDtePutWallHistory: NO_HISTORY,
    structuralCallWallHistory: NO_HISTORY,
    structuralPutWallHistory: NO_HISTORY,
    trendLabel: "up",
    volLabel: "normal",
    tenYearYield: 4.686,
    vix: 15.3,
    macroReadingTime: new Date("2026-08-11T18:00:00Z"),
    previousTenYearYield: null,
    previousVix: null,
    ...overrides,
  };
}

describe("generateDealerLevelReport", () => {
  it("is deterministic -- same input produces the exact same output", () => {
    const input = baseInput();
    expect(generateDealerLevelReport(input)).toBe(generateDealerLevelReport(input));
  });

  it("includes the real spot price, symbol, and session", () => {
    const report = generateDealerLevelReport(baseInput());
    expect(report).toContain("NQ");
    expect(report).toContain("New York");
    expect(report).toContain("29650.00");
  });

  it("reports 'no prior session snapshot' when neither bucket has history", () => {
    const report = generateDealerLevelReport(baseInput());
    expect(report).toContain("No prior session snapshot yet");
  });

  it("grades a prior structural floor as holding when spot is still above it", () => {
    const report = generateDealerLevelReport(
      baseInput({ previousStructural: { time: new Date("2026-08-10T22:00:00Z"), session: "asian", callWall: null, putWall: 29200, gammaFlip: null } })
    );
    expect(report).toContain("Structural put wall (floor) at 29200.00 is holding");
  });

  it("grades a prior structural ceiling as broken when spot has moved through it", () => {
    const report = generateDealerLevelReport(
      baseInput({ previousStructural: { time: new Date("2026-08-10T22:00:00Z"), session: "asian", callWall: 29600, putWall: null, gammaFlip: null } })
    );
    expect(report).toContain("Structural call wall (ceiling) at 29600.00 has broken");
  });

  it("reports the confirmed/unconfirmed status of each bucket's walls accurately", () => {
    const report = generateDealerLevelReport(baseInput());
    expect(report).toContain("Put wall (floor): 29600.00, 50.00 points below spot (5.00x ATR) -- confirmed by a real price-action pivot");
    expect(report).toContain("Call wall (ceiling): 29700.00, 50.00 points above spot (5.00x ATR) -- not independently confirmed by price action");
  });

  it("labels 0DTE and structural sections separately", () => {
    const report = generateDealerLevelReport(baseInput());
    expect(report).toContain("0DTE:");
    expect(report).toContain("Structural (1-7 days out):");
  });

  it("reports fusion when a 0DTE and structural wall of the same kind land within tolerance", () => {
    // 0DTE gammaFlip=29640, structural gammaFlip=29640 aren't checked for fusion (only call/put walls are) --
    // use put walls instead: 0DTE put=29600, structural put=29200 in baseInput diverge by far more than 0.5x ATR (5).
    const report = generateDealerLevelReport(
      baseInput({ structural: bucket({ callWall: 29750, putWall: 29603, gammaFlip: 29640 }) }) // within 0.5*10=5 of zeroDte's 29600
    );
    expect(report).toContain("0DTE and structural put walls agree");
  });

  it("reports divergence when a 0DTE and structural wall of the same kind land far apart", () => {
    const report = generateDealerLevelReport(baseInput()); // zeroDte put=29600, structural put=29200 -- 400pts apart
    expect(report).toContain("0DTE put wall (29600.00) and structural put wall (29200.00) diverge");
  });

  it("describes session-over-session wall movement when a prior snapshot exists", () => {
    const report = generateDealerLevelReport(
      baseInput({ previousStructural: { time: new Date("2026-08-10T22:00:00Z"), session: "asian", callWall: 29800, putWall: 29200, gammaFlip: null } })
    );
    expect(report).toContain("Structural call wall moved down from 29800.00 to 29750.00 (-50.00)");
  });

  it("reports a real computed hold rate once the touch floor is cleared, per bucket", () => {
    const report = generateDealerLevelReport(baseInput({ structuralPutWallHistory: { touches: 4, rejected: 3, broken: 1 } }));
    expect(report).toContain("structural put wall: held 3 of 4 times it's been touched (75%)");
  });

  it("never includes a scenario probability or percentage-chance claim", () => {
    const report = generateDealerLevelReport(baseInput());
    expect(report.toLowerCase()).not.toMatch(/\d+%\s*(chance|probability|odds)/);
    expect(report).toContain("no probabilities");
    expect(report).toContain("does not assign scenario odds");
  });

  it("frames a base/upside/downside scenario set from the 0DTE box when spot sits inside it", () => {
    const report = generateDealerLevelReport(baseInput()); // spot 29650, 0DTE put 29600 / call 29700 -- inside
    expect(report).toContain("Base case: price stays inside the 29600.00 (0DTE floor) - 29700.00 (0DTE ceiling) range");
    expect(report).toContain("Upside case: toward the 0DTE call wall at 29700.00");
    expect(report).toContain("Downside case: toward the 0DTE put wall at 29600.00");
  });

  it("handles a missing level (null) without crashing or fabricating a value", () => {
    const report = generateDealerLevelReport(baseInput({ zeroDte: bucket({ gammaFlip: null }) }));
    expect(report).toContain("Gamma flip (pivot): not currently available");
  });

  it("handles missing macro data honestly", () => {
    const report = generateDealerLevelReport(baseInput({ tenYearYield: null, vix: null, macroReadingTime: null }));
    expect(report).not.toContain("10Y yield");
  });

  it("describes a real macro delta when a previous reading exists", () => {
    const report = generateDealerLevelReport(baseInput({ previousTenYearYield: 4.65, tenYearYield: 4.686 }));
    expect(report).toContain("10Y yield moved up from 4.650 to 4.686");
  });

  it("includes a ranked tell hierarchy reflecting real regime/confirmation/history signals", () => {
    const report = generateDealerLevelReport(baseInput());
    expect(report).toContain("TELL HIERARCHY");
    expect(report).toContain("already trending up");
  });
});
