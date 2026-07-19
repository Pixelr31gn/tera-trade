/**
 * Standard Fibonacci retracement/extension levels computed from a trend's
 * swing high and low -- a manual decision-support reference for where to
 * place a stop-loss/take-profit on a live trade (see
 * engine/trendLevelsCache.ts, components/QuickOrderPanel.tsx). These are
 * descriptive reference prices, not a scored/gated signal -- the trader
 * picks which level to actually use.
 */
export interface FibLevel {
  ratio: number;
  label: string;
  price: number;
}

const RETRACEMENT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const EXTENSION_RATIOS = [1.272, 1.618];

/**
 * `direction` is which way the swing ran: "up" means the low happened before
 * the high (price rallied into it) -- retracement levels sit between the two
 * with 0% at the high and 100% at the low, extensions project above the
 * high. "down" is the mirror image.
 */
export function computeFibLevels(swingHigh: number, swingLow: number, direction: "up" | "down"): FibLevel[] {
  const range = swingHigh - swingLow;
  if (range <= 0) return [];

  const levels: FibLevel[] = [];
  for (const ratio of RETRACEMENT_RATIOS) {
    const price = direction === "up" ? swingHigh - range * ratio : swingLow + range * ratio;
    levels.push({ ratio, label: `${(ratio * 100).toFixed(1)}%`, price });
  }
  for (const ratio of EXTENSION_RATIOS) {
    const price = direction === "up" ? swingHigh + range * (ratio - 1) : swingLow - range * (ratio - 1);
    levels.push({ ratio, label: `${(ratio * 100).toFixed(1)}% ext`, price });
  }
  return levels.sort((a, b) => a.price - b.price);
}

export interface Swing {
  high: number;
  low: number;
  direction: "up" | "down";
}

/**
 * Finds the highest high and lowest low within `bars`, inferring the swing's
 * direction from which extreme occurred more recently (a swing still running
 * toward its most recent extreme). Bars must be in ascending chronological order.
 */
export function findSwing(bars: Array<{ high: number; low: number }>): Swing | null {
  if (bars.length === 0) return null;

  let highIdx = 0;
  let lowIdx = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.high > bars[highIdx]!.high) highIdx = i;
    if (bars[i]!.low < bars[lowIdx]!.low) lowIdx = i;
  }

  return { high: bars[highIdx]!.high, low: bars[lowIdx]!.low, direction: highIdx > lowIdx ? "up" : "down" };
}

/**
 * Normalized [-1, 1] signal for how well a setup's side matches the swing
 * structure it's actually inside of -- shared by every scoring version (see
 * scoring/ruleScorer.ts, scoring/ruleScorerV3.ts) so they all judge "does
 * this setup validate against Fibonacci structure" the same way, just weight
 * it differently. -1 = fighting the swing's direction entirely. +1 = aligned
 * AND sitting in the classic 38.2%-61.8% "healthy pullback" retracement
 * zone. Aligned but barely pulled back (<23.6%, chasing the move) or aligned
 * but deep into the retracement (>78.6%, swing structure at risk of
 * failing) score positively but lower -- hand-set tiers, not fitted.
 */
export function fibDirectionSignal(swingDirection: "up" | "down" | null, retracementPct: number | null, side: "long" | "short"): number {
  if (swingDirection === null) return 0;
  const aligned = (swingDirection === "up" && side === "long") || (swingDirection === "down" && side === "short");
  if (!aligned) return -1;
  if (retracementPct === null) return 0.5;
  if (retracementPct >= 0.382 && retracementPct <= 0.618) return 1;
  if (retracementPct < 0.236) return 0.4; // barely pulled back -- chasing the move
  if (retracementPct > 0.786) return 0.1; // deep retracement -- swing structure likely broken
  return 0.7; // moderate zones (23.6%-38.2% or 61.8%-78.6%)
}
