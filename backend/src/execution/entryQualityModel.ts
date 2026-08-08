/**
 * Entry Quality Model -- Phases 3-4 of the Execution Decision Engine:
 * scores every candidate price in a ladder around current price, using the
 * Fair Value Map (fairValueMap.ts), so the engine can pick the
 * highest-quality resting-limit price instead of buying/selling at
 * whatever price the signal happened to fire at.
 *
 * Weights below match the operator's specified model exactly (must sum to
 * 100). Every per-factor scoring curve is hand-set, not fitted against
 * resolved outcomes -- same "documented prior, revisit once real data
 * accumulates" posture the rest of this codebase's scorers already use
 * (see scoring/ruleScorerV3.ts). Expect these to be the first thing
 * recalibrated once Phase 6's logging has enough resolved trades.
 */
import type { EmaTrend } from "../analytics/emaTrend.js";
import type { FairValueMap } from "./fairValueMap.js";

export interface EntryQualityFactor {
  name: string;
  points: number;
  maxPoints: number;
  description: string;
}

export interface EntryQualityScore {
  price: number;
  /** Sum of every factor's points. NOTE: the operator's ten weights as specified (20/15/15/15/10/10/5/5/5/5) sum to 105, not 100 -- kept exactly as given rather than silently rescaled; max achievable is 105. */
  score: number;
  factors: EntryQualityFactor[];
}

function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Piecewise-linear interpolation through hand-set (x, y) anchor points -- same shape as scoring/ruleScorerV3.ts's helper of the same name. */
function interpolate(x: number, points: [number, number][]): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return points.at(-1)![1];
}

// 1. Trend Alignment -- 20 pts
function scoreTrendAlignment(emaTrend: EmaTrend, side: "long" | "short"): EntryQualityFactor {
  const max = 20;
  if (emaTrend.label === "neutral" || emaTrend.slope === null) {
    return { name: "trendAlignment", points: max * 0.4, maxPoints: max, description: "daily trend is flat -- no clear alignment either way" };
  }
  const aligned = (emaTrend.label === "bullish" && side === "long") || (emaTrend.label === "bearish" && side === "short");
  return {
    name: "trendAlignment",
    points: aligned ? max : max * 0.2,
    maxPoints: max,
    description: aligned ? `aligned with the daily ${emaTrend.label} trend` : `fights the daily ${emaTrend.label} trend`,
  };
}

// 2. Liquidity Position -- 15 pts (proximity to a volume-profile POC/VAH/VAL/HVN)
function scoreLiquidityPosition(price: number, fvm: FairValueMap): EntryQualityFactor {
  const max = 15;
  const refs = [fvm.volumeProfile.poc, fvm.volumeProfile.valueAreaHigh, fvm.volumeProfile.valueAreaLow, ...fvm.volumeProfile.highVolumeNodes].filter(
    (v): v is number => v !== null
  );
  if (refs.length === 0 || fvm.atrValue <= 0) {
    return { name: "liquidityPosition", points: max * 0.5, maxPoints: max, description: "no volume-profile data yet" };
  }
  const nearestDistanceAtr = Math.min(...refs.map((r) => Math.abs(price - r))) / fvm.atrValue;
  const closeness = interpolate(nearestDistanceAtr, [
    [0, 1],
    [0.5, 0.6],
    [1.5, 0],
  ]);
  return { name: "liquidityPosition", points: max * closeness, maxPoints: max, description: `${nearestDistanceAtr.toFixed(2)}x ATR from the nearest liquidity zone` };
}

// 3. Distance From Fair Value -- 15 pts (rewards a modest pullback toward fair value, not chasing OR overshooting)
function scoreDistanceFromFairValue(price: number, side: "long" | "short", fvm: FairValueMap): EntryQualityFactor {
  const max = 15;
  const fairValue = fvm.rollingVwap ?? fvm.sessionVwap ?? fvm.currentPrice;
  if (fvm.atrValue <= 0) return { name: "distanceFromFairValue", points: max * 0.5, maxPoints: max, description: "no ATR reading yet" };

  // Positive = favorable (a discount for a long, a premium for a short).
  const favorableDistanceAtr = (side === "long" ? fairValue - price : price - fairValue) / fvm.atrValue;
  const score = interpolate(favorableDistanceAtr, [
    [-0.5, 0.1],
    [0, 0.5],
    [0.3, 1],
    [0.8, 0.8],
    [1.5, 0.3],
  ]);
  return {
    name: "distanceFromFairValue",
    points: max * score,
    maxPoints: max,
    description: `${favorableDistanceAtr.toFixed(2)}x ATR ${favorableDistanceAtr >= 0 ? "favorable" : "unfavorable"} vs fair value (${fairValue.toFixed(2)})`,
  };
}

// 4. Risk/Reward -- 15 pts (a tighter entry against a fixed stop/target improves R:R -- this is what actually varies per candidate)
function scoreRiskReward(price: number, stopPrice: number, targetPrice: number): EntryQualityFactor {
  const max = 15;
  const risk = Math.abs(price - stopPrice);
  const reward = Math.abs(targetPrice - price);
  if (risk <= 0) return { name: "riskReward", points: 0, maxPoints: max, description: "entry is at or past the stop -- no valid risk" };
  const rr = reward / risk;
  // 1:1 scores near zero, 3:1 (this codebase's standing floor, see
  // risk/tradePlan.ts) scores full.
  const score = clip((rr - 1) / 2, 0, 1);
  return { name: "riskReward", points: max * score, maxPoints: max, description: `${rr.toFixed(2)}:1 reward:risk at this price` };
}

// 5. Support/Resistance -- 10 pts (reuses the same validated levels risk/engine.ts's proximity gate checks)
function scoreSupportResistance(price: number, side: "long" | "short", fvm: FairValueMap): EntryQualityFactor {
  const max = 10;
  const relevant = fvm.srLevels.filter((l) => (side === "long" ? l.type === "support" : l.type === "resistance"));
  if (relevant.length === 0 || fvm.atrValue <= 0) {
    return { name: "supportResistance", points: max * 0.3, maxPoints: max, description: "no validated level nearby" };
  }
  const nearest = relevant.reduce((best, l) => (Math.abs(l.price - price) < Math.abs(best.price - price) ? l : best));
  const distanceAtr = Math.abs(nearest.price - price) / fvm.atrValue;
  const closeness = clip(1 - distanceAtr, 0, 1);
  const touchBonus = clip(nearest.touches / 5, 0, 1) * 0.2;
  const score = clip(closeness + touchBonus, 0, 1);
  return {
    name: "supportResistance",
    points: max * score,
    maxPoints: max,
    description: `${distanceAtr.toFixed(2)}x ATR from ${nearest.type} at ${nearest.price.toFixed(2)} (${nearest.touches} touches)`,
  };
}

// 6. Order Flow -- 10 pts (absorption + delta divergence, both approximated -- see analytics/orderFlowAbsorption.ts)
function scoreOrderFlow(side: "long" | "short", fvm: FairValueMap): EntryQualityFactor {
  const max = 10;
  let score = 0.5;
  const reasons: string[] = [];

  if (fvm.absorption.detected) {
    const favorable = (side === "long" && fvm.absorption.side === "bid") || (side === "short" && fvm.absorption.side === "ask");
    score += favorable ? 0.3 : -0.3;
    reasons.push(fvm.absorption.description);
  }
  if (fvm.deltaDivergence.divergent) {
    // Divergence signals uncertainty rather than favoring either side here.
    score -= 0.1;
    reasons.push(fvm.deltaDivergence.description);
  }
  score = clip(score, 0, 1);
  return { name: "orderFlow", points: max * score, maxPoints: max, description: reasons.length ? reasons.join("; ") : "no notable order-flow signal" };
}

// 7. Volume Confluence -- 5 pts (how many volume-profile references cluster near this price)
function scoreVolumeConfluence(price: number, fvm: FairValueMap): EntryQualityFactor {
  const max = 5;
  const refs = [fvm.volumeProfile.poc, fvm.volumeProfile.valueAreaHigh, fvm.volumeProfile.valueAreaLow].filter((v): v is number => v !== null);
  if (refs.length === 0 || fvm.atrValue <= 0) {
    return { name: "volumeConfluence", points: max * 0.5, maxPoints: max, description: "no volume-profile data yet" };
  }
  const nearbyCount = refs.filter((r) => Math.abs(r - price) / fvm.atrValue < 0.5).length;
  const score = nearbyCount / refs.length;
  return { name: "volumeConfluence", points: max * score, maxPoints: max, description: `${nearbyCount}/${refs.length} volume references within 0.5x ATR` };
}

// 8. Momentum Condition -- 5 pts (never a standalone signal, same posture as scoring/ruleScorerV3.ts's RSI factor)
function scoreMomentum(side: "long" | "short", fvm: FairValueMap): EntryQualityFactor {
  const max = 5;
  if (fvm.rsi === null) return { name: "momentum", points: max * 0.5, maxPoints: max, description: "no RSI reading yet" };
  const unfavorableExtreme = side === "long" ? fvm.rsi > 75 : fvm.rsi < 25;
  return { name: "momentum", points: unfavorableExtreme ? max * 0.2 : max, maxPoints: max, description: `RSI ${fvm.rsi.toFixed(1)}` };
}

// 9. Volatility -- 5 pts (Bollinger bandwidth as a normalized volatility proxy)
function scoreVolatility(fvm: FairValueMap): EntryQualityFactor {
  const max = 5;
  if (fvm.bollinger === null) return { name: "volatility", points: max * 0.5, maxPoints: max, description: "no Bollinger reading yet" };
  const bw = fvm.bollinger.bandwidth;
  // ~2% bandwidth treated as "normal" for these instruments -- hand-set, not fitted.
  const score = clip(1 - Math.abs(bw - 0.02) / 0.04, 0, 1);
  return { name: "volatility", points: max * score, maxPoints: max, description: `Bollinger bandwidth ${(bw * 100).toFixed(2)}%` };
}

// 10. Slippage Estimate -- 5 pts (proxy: distance from current market price -- further means lower fill certainty)
function scoreSlippageEstimate(price: number, fvm: FairValueMap): EntryQualityFactor {
  const max = 5;
  if (fvm.atrValue <= 0) return { name: "slippageEstimate", points: max * 0.5, maxPoints: max, description: "no ATR reading yet" };
  const distanceAtr = Math.abs(price - fvm.currentPrice) / fvm.atrValue;
  const score = clip(1 - distanceAtr, 0, 1);
  return { name: "slippageEstimate", points: max * score, maxPoints: max, description: `${distanceAtr.toFixed(2)}x ATR from current price` };
}

export function scoreEntryCandidate(params: {
  price: number;
  side: "long" | "short";
  stopPrice: number;
  targetPrice: number;
  emaTrend: EmaTrend;
  fvm: FairValueMap;
}): EntryQualityScore {
  const { price, side, stopPrice, targetPrice, emaTrend, fvm } = params;
  const factors: EntryQualityFactor[] = [
    scoreTrendAlignment(emaTrend, side),
    scoreLiquidityPosition(price, fvm),
    scoreDistanceFromFairValue(price, side, fvm),
    scoreRiskReward(price, stopPrice, targetPrice),
    scoreSupportResistance(price, side, fvm),
    scoreOrderFlow(side, fvm),
    scoreVolumeConfluence(price, fvm),
    scoreMomentum(side, fvm),
    scoreVolatility(fvm),
    scoreSlippageEstimate(price, fvm),
  ];
  const score = factors.reduce((sum, f) => sum + f.points, 0);
  return { price, score, factors };
}

/** Candidate prices from current price out to `ticksEachSide`, on the side that represents "waiting for a pullback" (below current for a long, above for a short) -- includes current price itself so "just take it now" can still win if nothing better scores higher. */
export function buildEntryLadder(currentPrice: number, tickSize: number, side: "long" | "short", ticksEachSide = 40): number[] {
  const direction = side === "long" ? -1 : 1;
  const prices: number[] = [];
  for (let i = 0; i <= ticksEachSide; i++) {
    prices.push(currentPrice + direction * i * tickSize);
  }
  return prices;
}

export function scoreEntryLadder(params: {
  currentPrice: number;
  tickSize: number;
  side: "long" | "short";
  stopPrice: number;
  targetPrice: number;
  emaTrend: EmaTrend;
  fvm: FairValueMap;
  ticksEachSide?: number;
}): EntryQualityScore[] {
  const { currentPrice, tickSize, side, stopPrice, targetPrice, emaTrend, fvm, ticksEachSide = 40 } = params;
  return buildEntryLadder(currentPrice, tickSize, side, ticksEachSide).map((price) =>
    scoreEntryCandidate({ price, side, stopPrice, targetPrice, emaTrend, fvm })
  );
}

/** Highest-scoring candidate that clears minThreshold, or null if nothing does (see Phase 5's engine.ts wiring for what happens then). */
export function selectBestEntry(scores: EntryQualityScore[], minThreshold: number): EntryQualityScore | null {
  const eligible = scores.filter((s) => s.score >= minThreshold);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, s) => (s.score > best.score ? s : best));
}
