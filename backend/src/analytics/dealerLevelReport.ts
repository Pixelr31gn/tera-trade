/**
 * Narrative session report -- deterministic prose generated from real,
 * computed inputs only (2026-08-11, operator request, following the "WHAT
 * HAPPENED" style report the operator uses as a reference). No invented
 * numbers: every figure in the output is either a direct input or simple
 * arithmetic over one, and every historical claim ("held N of M times") is a
 * real count from engine/dealerLevelOutcomeEvaluator.ts's accumulated data,
 * or an explicit "not enough history yet." This is a template, not an LLM
 * call -- same determinism/testability posture as explain/engine.ts's plain-
 * English score explanations.
 *
 * Restructured 2026-08-11 (same-day follow-up, operator request: "this is
 * the logic the report needs to have," pasting a paid-vendor reference report
 * as the target shape) into four sections mirroring that reference's real
 * analytical content -- WHAT HAPPENED (session-over-session grading),
 * THE MAP (0DTE book vs. structural book, and where they reinforce or
 * diverge), SCENARIOS (base/upside/downside, ranked by real reasoning), and
 * a TELL hierarchy -- while deliberately NOT copying two things from that
 * reference that don't have an honest equivalent here: (1) its specific
 * scenario percentages (55%/30%/15%) have no backtested basis in this
 * system yet -- the operator was shown this exact tension and chose
 * qualitative ranking over an invented-but-confident-sounding number, same
 * choice as the original 2026-08-11 version of this file; (2) its named
 * levels (BL/RT/PS/CR/GW/HVL/1D-Min/"long node") are a specific vendor's
 * proprietary metrics this system doesn't compute and can't honestly
 * relabel -- see marketData/dealerGex.ts's computeDealerLevelsBucketed for
 * what IS real here: a genuine 0DTE-vs-structural split of the same free
 * CBOE chain, which is the one piece of that reference's richness this
 * system can actually earn honestly.
 *
 * Kept pure per CLAUDE.md -- no fetch, no Date.now(), no prisma. The
 * historical-stats/macro/dealer-level lookups live in marketData/dealerGex.ts
 * and marketData/macroIndicators.ts; engine/dealerLevelReportBuilder.ts
 * assembles this file's input from them. This file only turns already-
 * fetched data into text.
 */
import type { TradingSession } from "./session.js";

export interface WallHistoricalStats {
  touches: number;
  rejected: number;
  broken: number;
}

export interface BucketSnapshot {
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  callWallConfirmed: boolean;
  putWallConfirmed: boolean;
}

export interface PreviousBucketSnapshot {
  time: Date;
  session: TradingSession;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
}

export interface DealerLevelReportInput {
  symbol: string;
  session: TradingSession;
  time: Date;
  spotPrice: number;
  atrValue: number | null;

  zeroDte: BucketSnapshot;
  structural: BucketSnapshot;
  /** Most recent snapshot from a PRIOR session, per bucket -- null when none exists yet (first-ever computation for this symbol/bucket). */
  previousZeroDte: PreviousBucketSnapshot | null;
  previousStructural: PreviousBucketSnapshot | null;

  zeroDteCallWallHistory: WallHistoricalStats;
  zeroDtePutWallHistory: WallHistoricalStats;
  structuralCallWallHistory: WallHistoricalStats;
  structuralPutWallHistory: WallHistoricalStats;

  trendLabel: "up" | "down" | "none";
  volLabel: "high" | "normal" | "low";

  tenYearYield: number | null;
  vix: number | null;
  macroReadingTime: Date | null;
  /** Most recent macro reading from BEFORE this one -- for the WHAT HAPPENED delta. Null when none exists yet. */
  previousTenYearYield: number | null;
  previousVix: number | null;
}

const SESSION_LABELS: Record<TradingSession, string> = { new_york: "New York", london: "London", asian: "Asian" };

// Minimum touch count before a hold rate is reported as a real number rather
// than "not enough history yet" -- same floor scoring/sessionPerformance.ts
// uses for its own session-win-rate gate (MIN_SESSION_SAMPLES_PER_VERSION),
// reused here for the identical reason: a rate computed from 1-2 samples is
// noise dressed up as a statistic.
const MIN_TOUCHES_FOR_HOLD_RATE = 3;

// A 0DTE and structural level within this many ATR of each other are
// reported as "fused" (independent expiration windows agreeing) rather than
// two separate, coincidentally-close numbers -- reuses
// analytics/dealerGex.ts's own confirmation-tolerance philosophy (0.5x ATR)
// rather than inventing a second tolerance constant.
const FUSION_TOLERANCE_ATR_MULTIPLE = 0.5;

function describeDistance(label: string, price: number, level: number | null, atrValue: number | null): string {
  if (level === null) return `${label}: not currently available`;
  const points = Math.abs(price - level);
  const direction = level > price ? "above" : "below";
  const atrPart = atrValue !== null && atrValue > 0 ? ` (${(points / atrValue).toFixed(2)}x ATR)` : "";
  return `${label}: ${level.toFixed(2)}, ${points.toFixed(2)} points ${direction} spot${atrPart}`;
}

function describeHoldRate(history: WallHistoricalStats): string {
  if (history.touches < MIN_TOUCHES_FOR_HOLD_RATE) {
    return `not enough history yet to say (${history.touches} recorded touch${history.touches === 1 ? "" : "es"})`;
  }
  const holdRate = history.rejected / history.touches;
  return `held ${history.rejected} of ${history.touches} times it's been touched (${Math.round(holdRate * 100)}%)`;
}

function describeSessionDelta(label: string, from: number | null, to: number | null, decimals = 2): string | null {
  if (from === null || to === null) return null;
  const delta = to - from;
  const threshold = 0.5 * 10 ** -decimals;
  if (Math.abs(delta) < threshold) return `${label} unchanged at ${to.toFixed(decimals)} since the last session`;
  const dir = delta > 0 ? "up" : "down";
  return `${label} moved ${dir} from ${from.toFixed(decimals)} to ${to.toFixed(decimals)} (${delta > 0 ? "+" : ""}${delta.toFixed(decimals)}) since the last session`;
}

/** Did spot end up on the "held" side of a prior-session level, given which side it's meant to defend? "floor" = level should stay below spot; "ceiling" = level should stay above spot. */
function describeHoldOrBreak(label: string, priorLevel: number | null, currentSpot: number, kind: "floor" | "ceiling"): string | null {
  if (priorLevel === null) return null;
  const holding = kind === "floor" ? currentSpot >= priorLevel : currentSpot <= priorLevel;
  const points = Math.abs(currentSpot - priorLevel);
  return holding
    ? `${label} at ${priorLevel.toFixed(2)} is holding -- spot is still ${points.toFixed(2)} points on the defended side`
    : `${label} at ${priorLevel.toFixed(2)} has broken -- spot is now ${points.toFixed(2)} points through it`;
}

function buildWhatHappened(input: DealerLevelReportInput): string[] {
  const lines: string[] = [`WHAT HAPPENED (since the last session's snapshot)`];
  const hadPrior = input.previousZeroDte !== null || input.previousStructural !== null;

  if (!hadPrior) {
    lines.push(`  No prior session snapshot yet -- this is the first computed map for ${input.symbol}.`);
  } else {
    const grading: string[] = [];
    const struct = input.previousStructural;
    if (struct) {
      const put = describeHoldOrBreak("Structural put wall (floor)", struct.putWall, input.spotPrice, "floor");
      const call = describeHoldOrBreak("Structural call wall (ceiling)", struct.callWall, input.spotPrice, "ceiling");
      if (put) grading.push(put);
      if (call) grading.push(call);
    }
    const zdte = input.previousZeroDte;
    if (zdte) {
      const put = describeHoldOrBreak("0DTE put wall (floor)", zdte.putWall, input.spotPrice, "floor");
      const call = describeHoldOrBreak("0DTE call wall (ceiling)", zdte.callWall, input.spotPrice, "ceiling");
      if (put) grading.push(put);
      if (call) grading.push(call);
    }
    if (grading.length === 0) grading.push("Prior snapshot existed but had no walls to grade against.");
    for (const g of grading) lines.push(`  ${g}`);
  }

  const macroLines: string[] = [];
  const tenY = describeSessionDelta("10Y yield", input.previousTenYearYield, input.tenYearYield, 3);
  const vix = describeSessionDelta("VIX", input.previousVix, input.vix);
  if (tenY) macroLines.push(tenY);
  if (vix) macroLines.push(vix);
  if (macroLines.length > 0) {
    lines.push(`  ${macroLines.join("; ")}.`);
  } else if (input.tenYearYield !== null || input.vix !== null) {
    const parts: string[] = [];
    if (input.tenYearYield !== null) parts.push(`10Y yield ${input.tenYearYield.toFixed(3)}%`);
    if (input.vix !== null) parts.push(`VIX ${input.vix.toFixed(2)}`);
    lines.push(`  ${parts.join(", ")} (no prior reading to compare against yet).`);
  }

  return lines;
}

function buildTheMap(input: DealerLevelReportInput): string[] {
  const lines: string[] = ["THE MAP (0DTE book vs. structural book, same free CBOE chain)"];

  lines.push("  0DTE:");
  lines.push(`    ${describeDistance("Call wall (ceiling)", input.spotPrice, input.zeroDte.callWall, input.atrValue)}${input.zeroDte.callWall !== null ? (input.zeroDte.callWallConfirmed ? " -- confirmed by a real price-action pivot" : " -- not independently confirmed by price action") : ""}`);
  lines.push(`    ${describeDistance("Put wall (floor)", input.spotPrice, input.zeroDte.putWall, input.atrValue)}${input.zeroDte.putWall !== null ? (input.zeroDte.putWallConfirmed ? " -- confirmed by a real price-action pivot" : " -- not independently confirmed by price action") : ""}`);
  lines.push(`    ${describeDistance("Gamma flip (pivot)", input.spotPrice, input.zeroDte.gammaFlip, input.atrValue)}`);

  lines.push("  Structural (1-7 days out):");
  lines.push(`    ${describeDistance("Call wall (ceiling)", input.spotPrice, input.structural.callWall, input.atrValue)}${input.structural.callWall !== null ? (input.structural.callWallConfirmed ? " -- confirmed by a real price-action pivot" : " -- not independently confirmed by price action") : ""}`);
  lines.push(`    ${describeDistance("Put wall (floor)", input.spotPrice, input.structural.putWall, input.atrValue)}${input.structural.putWall !== null ? (input.structural.putWallConfirmed ? " -- confirmed by a real price-action pivot" : " -- not independently confirmed by price action") : ""}`);
  lines.push(`    ${describeDistance("Gamma flip (pivot)", input.spotPrice, input.structural.gammaFlip, input.atrValue)}`);

  // Fusion: two independent expiration windows agreeing (or not) on where a
  // wall sits -- real signal, computed from real distance, not asserted.
  if (input.atrValue !== null && input.atrValue > 0) {
    const tolerance = input.atrValue * FUSION_TOLERANCE_ATR_MULTIPLE;
    const fusionLines: string[] = [];
    const checkFusion = (kind: string, zdte: number | null, structural: number | null) => {
      if (zdte === null || structural === null) return;
      if (Math.abs(zdte - structural) <= tolerance) {
        fusionLines.push(`0DTE and structural ${kind} walls agree (~${((zdte + structural) / 2).toFixed(2)}) -- two independent expiration windows reinforcing the same level.`);
      } else {
        fusionLines.push(`0DTE ${kind} wall (${zdte.toFixed(2)}) and structural ${kind} wall (${structural.toFixed(2)}) diverge by ${Math.abs(zdte - structural).toFixed(2)} points -- the near-dated and broader books disagree here.`);
      }
    };
    checkFusion("call", input.zeroDte.callWall, input.structural.callWall);
    checkFusion("put", input.zeroDte.putWall, input.structural.putWall);
    if (fusionLines.length > 0) {
      lines.push("  Fusion:");
      for (const f of fusionLines) lines.push(`    ${f}`);
    }
  }

  const movementLines: string[] = [];
  if (input.previousZeroDte) {
    const call = describeSessionDelta("0DTE call wall", input.previousZeroDte.callWall, input.zeroDte.callWall);
    const put = describeSessionDelta("0DTE put wall", input.previousZeroDte.putWall, input.zeroDte.putWall);
    if (call) movementLines.push(call);
    if (put) movementLines.push(put);
  }
  if (input.previousStructural) {
    const call = describeSessionDelta("Structural call wall", input.previousStructural.callWall, input.structural.callWall);
    const put = describeSessionDelta("Structural put wall", input.previousStructural.putWall, input.structural.putWall);
    if (call) movementLines.push(call);
    if (put) movementLines.push(put);
  }
  if (movementLines.length > 0) {
    lines.push("  Since last session:");
    for (const m of movementLines) lines.push(`    ${m}.`);
  }

  return lines;
}

function buildScenarios(input: DealerLevelReportInput): string[] {
  const lines: string[] = [
    "SCENARIOS (qualitative -- no probabilities: Tera Trade has no backtested basis for weighting these numerically yet, only real distance/confirmation reasoning)",
  ];

  // Prefer the 0DTE book for the near-term box (it's what's actually in
  // play tonight); fall back to structural when 0DTE has nothing.
  const floor = input.zeroDte.putWall ?? input.structural.putWall;
  const floorSource = input.zeroDte.putWall !== null ? "0DTE" : "structural";
  const ceiling = input.zeroDte.callWall ?? input.structural.callWall;
  const ceilingSource = input.zeroDte.callWall !== null ? "0DTE" : "structural";

  if (floor !== null && ceiling !== null) {
    const inBox = input.spotPrice > floor && input.spotPrice < ceiling;
    lines.push(
      inBox
        ? `  Base case: price stays inside the ${floor.toFixed(2)} (${floorSource} floor) - ${ceiling.toFixed(2)} (${ceilingSource} ceiling) range -- spot is currently inside it.`
        : `  Base case: price is currently OUTSIDE the ${floor.toFixed(2)}-${ceiling.toFixed(2)} box already -- the more relevant question is which side it's testing, not whether the box holds.`
    );
    lines.push(
      `  Upside case: toward the ${ceilingSource} call wall at ${ceiling.toFixed(2)}${input.zeroDte.callWall !== null && input.zeroDte.callWallConfirmed ? " (independently confirmed by price action -- real evidence behind it, not just the GEX math)" : ""}.`
    );
    lines.push(
      `  Downside case: toward the ${floorSource} put wall at ${floor.toFixed(2)}${input.zeroDte.putWall !== null && input.zeroDte.putWallConfirmed ? " (independently confirmed by price action -- real evidence behind it, not just the GEX math)" : ""}.`
    );
  } else {
    lines.push("  Not enough wall data on either side to frame a box yet.");
  }

  return lines;
}

function buildTellHierarchy(input: DealerLevelReportInput): string[] {
  const lines: string[] = ["TELL HIERARCHY (what to watch, ranked by how real the evidence behind it is)"];
  const tells: string[] = [];

  if (input.trendLabel !== "none") {
    tells.push(`Regime is already trending ${input.trendLabel} -- a move toward the wall in that direction is the path of least resistance, not a coin flip.`);
  }

  const confirmedWalls: string[] = [];
  if (input.zeroDte.callWallConfirmed) confirmedWalls.push("0DTE call wall");
  if (input.zeroDte.putWallConfirmed) confirmedWalls.push("0DTE put wall");
  if (input.structural.callWallConfirmed) confirmedWalls.push("structural call wall");
  if (input.structural.putWallConfirmed) confirmedWalls.push("structural put wall");
  if (confirmedWalls.length > 0) {
    tells.push(`${confirmedWalls.join(" and ")} ${confirmedWalls.length === 1 ? "is" : "are"} independently confirmed by real price-action pivots -- stronger evidence than the GEX math alone.`);
  }

  const historyTells: string[] = [];
  if (input.structuralCallWallHistory.touches >= MIN_TOUCHES_FOR_HOLD_RATE) historyTells.push(`structural call wall: ${describeHoldRate(input.structuralCallWallHistory)}`);
  if (input.structuralPutWallHistory.touches >= MIN_TOUCHES_FOR_HOLD_RATE) historyTells.push(`structural put wall: ${describeHoldRate(input.structuralPutWallHistory)}`);
  if (input.zeroDteCallWallHistory.touches >= MIN_TOUCHES_FOR_HOLD_RATE) historyTells.push(`0DTE call wall: ${describeHoldRate(input.zeroDteCallWallHistory)}`);
  if (input.zeroDtePutWallHistory.touches >= MIN_TOUCHES_FOR_HOLD_RATE) historyTells.push(`0DTE put wall: ${describeHoldRate(input.zeroDtePutWallHistory)}`);
  if (historyTells.length > 0) {
    tells.push(`Real accumulated hold-rate exists for this symbol -- ${historyTells.join("; ")} -- beats the raw GEX math alone.`);
  }

  if (input.tenYearYield !== null || input.vix !== null) {
    const parts: string[] = [];
    if (input.tenYearYield !== null) parts.push(`10Y yield ${input.tenYearYield.toFixed(3)}%`);
    if (input.vix !== null) parts.push(`VIX ${input.vix.toFixed(2)}`);
    tells.push(`Macro backdrop: ${parts.join(", ")} -- flagged last, since Tera Trade has no calibrated trigger level for either yet, only the real current reading.`);
  }

  if (tells.length === 0) {
    lines.push("  Nothing beyond the raw GEX levels above -- no regime trend, no price-action confirmation, and no accumulated history yet.");
  } else {
    tells.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
  }

  return lines;
}

/** Pure -- deterministic given the same input. No randomness, no invented figures, no scenario percentages. */
export function generateDealerLevelReport(input: DealerLevelReportInput): string {
  const sessionLabel = SESSION_LABELS[input.session];
  const sections: string[] = [];

  sections.push(`${input.symbol} -- ${sessionLabel} session, as of ${input.time.toISOString()}\nSpot: ${input.spotPrice.toFixed(2)}`);
  sections.push(buildWhatHappened(input).join("\n"));
  sections.push(buildTheMap(input).join("\n"));
  sections.push(buildScenarios(input).join("\n"));
  sections.push(`Regime: ${input.trendLabel === "none" ? "no clear trend" : `${input.trendLabel} trend`}, ${input.volLabel} volatility.`);
  sections.push(buildTellHierarchy(input).join("\n"));
  sections.push(
    "This report states what's actually known -- real levels, real macro readings, real historical hold rates once " +
      "enough of them exist, and a real 0DTE/structural split of the same free CBOE chain. It does not assign scenario " +
      "odds: Tera Trade has no backtested basis for that yet, and a confident-sounding number that isn't real would be " +
      "worse than none."
  );

  return sections.join("\n\n");
}
