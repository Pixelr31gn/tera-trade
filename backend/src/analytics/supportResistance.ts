/**
 * Support/resistance level detection from swing pivots -- the actual price
 * levels a trade is entered near, not just a stop/target reference.
 *
 * A pivot high/low is a bar whose high/low is the most extreme within a
 * window on both sides (a classic fractal pivot). Nearby pivots get
 * clustered into a single "level" -- the more pivots that cluster together,
 * the more times price has actually reversed near that price, and the more
 * significant the level is treated as (touches = strength).
 */
import type { OhlcBar } from "../regime/indicators.js";

export interface SrLevel {
  price: number;
  touches: number;
  type: "support" | "resistance"; // relative to the current price passed to computeSupportResistanceLevels
}

const PIVOT_LOOKAROUND = 3; // bars required on each side to confirm a local extreme

export interface Pivot {
  price: number;
  kind: "high" | "low";
}

export function detectPivots(bars: OhlcBar[], lookaround = PIVOT_LOOKAROUND): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = lookaround; i < bars.length - lookaround; i++) {
    const window = bars.slice(i - lookaround, i + lookaround + 1);
    const bar = bars[i]!;
    if (bar.high === Math.max(...window.map((b) => b.high))) pivots.push({ price: bar.high, kind: "high" });
    if (bar.low === Math.min(...window.map((b) => b.low))) pivots.push({ price: bar.low, kind: "low" });
  }
  return pivots;
}

/** Merges pivots within `tolerance` price units of their neighbor into one level, averaging the cluster's prices. */
export function clusterLevels(pivots: Pivot[], tolerance: number): { price: number; touches: number }[] {
  if (pivots.length === 0 || tolerance <= 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);

  const clusters: number[][] = [];
  for (const pivot of sorted) {
    const current = clusters.at(-1);
    if (current && pivot.price - current.at(-1)! <= tolerance) {
      current.push(pivot.price);
    } else {
      clusters.push([pivot.price]);
    }
  }

  return clusters.map((prices) => ({ price: prices.reduce((a, b) => a + b, 0) / prices.length, touches: prices.length }));
}

// A level within half an ATR of another is treated as "the same" level --
// hand-set, not fitted, same philosophy as the rest of this codebase's
// scoring constants.
const CLUSTER_TOLERANCE_ATR_MULTIPLE = 0.5;

export function computeSupportResistanceLevels(bars: OhlcBar[], currentPrice: number, atrValue: number): SrLevel[] {
  if (atrValue <= 0) return [];
  const pivots = detectPivots(bars);
  const clustered = clusterLevels(pivots, atrValue * CLUSTER_TOLERANCE_ATR_MULTIPLE);
  return clustered
    .map((c) => ({ price: c.price, touches: c.touches, type: (c.price < currentPrice ? "support" : "resistance") as "support" | "resistance" }))
    .sort((a, b) => a.price - b.price);
}

export interface NearestLevelResult {
  level: SrLevel;
  distancePoints: number;
  distanceInAtr: number;
}

// A level formed from a single pivot is just one swing point, not a place
// price has actually been rejected from before -- real support/resistance
// significance (the kind worth trading off of) requires at least one repeat
// touch. Applies to both the reversal gate below and the breakout gate in
// risk/engine.ts.
export const MIN_LEVEL_TOUCHES = 2;

/** A long wants to enter near support (a floor to buy from); a short wants to enter near resistance (a ceiling to sell into). Only for reversal/bounce-style signals -- see Signal.signalKind. */
export function findNearestRelevantLevel(levels: SrLevel[], side: "long" | "short", currentPrice: number, atrValue: number): NearestLevelResult | null {
  const wantType = side === "long" ? "support" : "resistance";
  const relevant = levels.filter((l) => l.type === wantType && l.touches >= MIN_LEVEL_TOUCHES);
  if (relevant.length === 0) return null;

  const nearest = relevant.reduce((closest, l) => (Math.abs(l.price - currentPrice) < Math.abs(closest.price - currentPrice) ? l : closest));
  const distancePoints = Math.abs(nearest.price - currentPrice);
  return { level: nearest, distancePoints, distanceInAtr: atrValue > 0 ? distancePoints / atrValue : Infinity };
}

/**
 * Where price is actually likely headed, in the trade's favor -- the
 * opposite lookup from findNearestRelevantLevel above (which finds the
 * level an entry should be near, i.e. a floor to buy from / ceiling to sell
 * into). A long's target is the nearest RESISTANCE above current price; a
 * short's is the nearest SUPPORT below it. Same 2+ touch requirement as
 * everywhere else in this file -- a level formed from one untested pivot
 * isn't a real target either, just a swing point. Returns null when no such
 * level exists (e.g. price has already run past every prior pivot in a
 * strong trend) -- callers should fall back to a generic target, not block
 * the trade on this alone.
 */
export function findNearestTargetLevel(levels: SrLevel[], side: "long" | "short", currentPrice: number): SrLevel | null {
  const wantType = side === "long" ? "resistance" : "support";
  const relevant = levels.filter((l) => l.type === wantType && l.touches >= MIN_LEVEL_TOUCHES);
  if (relevant.length === 0) return null;
  return relevant.reduce((closest, l) => (Math.abs(l.price - currentPrice) < Math.abs(closest.price - currentPrice) ? l : closest));
}

/**
 * For a breakout signal: finds the detected level cluster nearest to the
 * *specific* price the strategy says it broke through (not the nearest
 * level to current price, which -- as the breakout runs further from the
 * break point -- can latch onto an unrelated, weakly-touched pivot in the
 * trade's direction and reject an increasingly strong move for looking
 * "too far from a level," when the level in question was never the level
 * being broken at all).
 */
export function findLevelNearBreakout(levels: SrLevel[], breakoutLevelPrice: number, currentPrice: number, atrValue: number): NearestLevelResult | null {
  if (levels.length === 0) return null;
  const nearest = levels.reduce((closest, l) => (Math.abs(l.price - breakoutLevelPrice) < Math.abs(closest.price - breakoutLevelPrice) ? l : closest));
  const distancePoints = Math.abs(currentPrice - breakoutLevelPrice);
  return { level: nearest, distancePoints, distanceInAtr: atrValue > 0 ? distancePoints / atrValue : Infinity };
}
