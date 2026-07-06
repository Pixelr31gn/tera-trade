/**
 * v1 trade-scoring model: a documented, weighted rule-based scorer.
 *
 * There is no trade history to train a real model on yet, so Tera Trade
 * ships with a transparent heuristic instead of a black box. Every factor's
 * contribution is returned alongside the score so the explanation engine can
 * say *why* a setup scored the way it did. Once `trades` has enough labeled
 * rows, scoring/training.ts can fit a calibrated model that supersedes this
 * scorer without changing anything downstream (both implement the same
 * `score(features) -> ScoreResult` contract).
 */
import type { SetupFeatures } from "./features.js";

// Weights are hand-set, documented priors -- not fit to data. Magnitudes
// reflect how strongly each factor should move the pre-threshold
// probability; news risk dominates deliberately (never assume a clean setup
// outweighs event risk).
const WEIGHTS = {
  trendAlignment: 1.1,
  dailyTrendAlignment: 1.8,
  momentumAlignment: 0.8,
  adxStrength: 0.6,
  volatilityRegime: 0.5,
  volumeConfirmation: 0.4,
  session: 0.3,
  newsRisk: 1.6,
  historicalEdge: 0.9,
  openingRangeEdge: 0.7,
};

const BASE_LOGIT = -0.2; // slight negative prior so an empty/neutral setup scores below 0.5

// Below this many historical sessions, the opening-range breakout
// probability is too noisy to trust -- ignore it rather than let a handful
// of days swing the score.
const MIN_OPENING_RANGE_SAMPLE_SIZE = 15;

export interface FactorContribution {
  name: string;
  contribution: number;
  description: string;
}

export interface ScoreResult {
  probability: number;
  factors: FactorContribution[];
}

function clip(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

export function scoreSetup(features: SetupFeatures): ScoreResult {
  const direction = features.side === "long" ? 1 : -1;
  const factors: FactorContribution[] = [];
  let logit = BASE_LOGIT;

  // 1. Trend alignment
  {
    let raw: number;
    let desc: string;
    if (features.trendLabel === "none") {
      raw = -0.3;
      desc = "market is in a ranging regime, not clearly trending";
    } else if ((features.trendLabel === "up" && direction === 1) || (features.trendLabel === "down" && direction === -1)) {
      raw = 1.0;
      desc = `setup direction agrees with the prevailing ${features.trendLabel} trend`;
    } else {
      raw = -1.0;
      desc = `setup direction fights the prevailing ${features.trendLabel} trend`;
    }
    const contribution = WEIGHTS.trendAlignment * raw;
    logit += contribution;
    factors.push({ name: "trendAlignment", contribution, description: desc });
  }

  // 2. Daily trend alignment -- the intraday regime above can flip within a
  // single session as short-term noise passes through; the daily trend
  // (computed from ~1yr of daily bars, see engine/dailyTrendCache.ts) is far
  // stickier and is weighted more heavily than the intraday one deliberately,
  // so a setup that fights a confident daily trend rarely clears the score
  // threshold no matter how good it looks on the last few minutes of bars.
  // This is the main defense against long/short/short/long whipsaw.
  {
    let raw: number;
    let desc: string;
    if (features.dailyTrendLabel === "none") {
      raw = -0.2;
      desc = "no clear daily trend to confirm this setup's direction";
    } else if ((features.dailyTrendLabel === "up" && direction === 1) || (features.dailyTrendLabel === "down" && direction === -1)) {
      raw = features.dailyTrendConfidence;
      desc = `agrees with the daily ${features.dailyTrendLabel} trend (${(features.dailyTrendConfidence * 100).toFixed(0)}% confidence)`;
    } else {
      raw = -clip(0.6 + features.dailyTrendConfidence);
      desc = `fights the daily ${features.dailyTrendLabel} trend (${(features.dailyTrendConfidence * 100).toFixed(0)}% confidence)`;
    }
    const contribution = WEIGHTS.dailyTrendAlignment * raw;
    logit += contribution;
    factors.push({ name: "dailyTrendAlignment", contribution, description: desc });
  }

  // 3. Momentum alignment
  if (features.momentum10 !== null) {
    const raw = clip(direction * features.momentum10 * 20);
    const desc = raw > 0 ? "recent momentum supports the setup" : "recent momentum opposes the setup";
    const contribution = WEIGHTS.momentumAlignment * raw;
    logit += contribution;
    factors.push({ name: "momentumAlignment", contribution, description: desc });
  }

  // 4. ADX trend strength (only rewarded when trend is aligned)
  if (features.adx !== null && features.trendLabel !== "none") {
    const aligned = (features.trendLabel === "up") === (direction === 1);
    const raw = aligned ? clip((features.adx - 20) / 30) : 0;
    if (raw) {
      const contribution = WEIGHTS.adxStrength * raw;
      logit += contribution;
      factors.push({ name: "adxStrength", contribution, description: `ADX=${features.adx.toFixed(1)} confirms trend strength` });
    }
  }

  // 5. Volatility regime -- high vol adds noise/slippage risk, low vol is cleaner
  {
    let raw: number;
    let desc: string;
    if (features.volLabel === "high") {
      raw = -0.6;
      desc = "volatility regime is elevated, increasing noise and slippage risk";
    } else if (features.volLabel === "low") {
      raw = 0.2;
      desc = "volatility regime is low, favoring cleaner follow-through";
    } else {
      raw = 0.0;
      desc = "volatility regime is normal";
    }
    const contribution = WEIGHTS.volatilityRegime * raw;
    logit += contribution;
    factors.push({ name: "volatilityRegime", contribution, description: desc });
  }

  // 6. Volume confirmation
  if (features.volumeZscore !== null) {
    const momentumAligned = direction * (features.momentum10 ?? 0) >= 0;
    const raw = momentumAligned ? clip(features.volumeZscore / 2) : 0;
    if (raw) {
      const contribution = WEIGHTS.volumeConfirmation * raw;
      logit += contribution;
      factors.push({ name: "volumeConfirmation", contribution, description: "above-average volume confirms the move" });
    }
  }

  // 7. Session
  {
    const raw = features.isRthSession ? 0.3 : -0.3;
    const desc = features.isRthSession
      ? "regular trading hours favor liquidity and tighter spreads"
      : "outside regular trading hours, liquidity is thinner";
    const contribution = WEIGHTS.session * raw;
    logit += contribution;
    factors.push({ name: "session", contribution, description: desc });
  }

  // 8. News risk -- dominant, deliberately punitive
  if (features.newsRiskFlag) {
    let proximity = 1.0;
    if (features.newsMinutesToEvent !== null) {
      proximity = clip(1 - Math.abs(features.newsMinutesToEvent) / 30, 0, 1) + 0.3;
    }
    const raw = -clip(proximity);
    const contribution = WEIGHTS.newsRisk * raw;
    logit += contribution;
    factors.push({ name: "newsRisk", contribution, description: "a high-impact news event is imminent or just released" });
  }

  // 9. Strategy's own historical edge, if we have enough trades to know it
  if (features.strategyHistoricalWinRate !== null) {
    const raw = clip((features.strategyHistoricalWinRate - 0.5) * 2);
    const contribution = WEIGHTS.historicalEdge * raw;
    logit += contribution;
    factors.push({
      name: "historicalEdge",
      contribution,
      description: `this strategy's historical win rate is ${(features.strategyHistoricalWinRate * 100).toFixed(0)}%`,
    });
  }

  // 10. Opening-range breakout edge -- empirical, not a heuristic weight: how
  // often has this instrument's first-hour high/low actually gotten broken
  // later in the session, historically, in this setup's direction? Ignored
  // until there's enough sessions behind it to be more signal than noise.
  if (features.openingRangeBreakoutProbability !== null && features.openingRangeSampleSize >= MIN_OPENING_RANGE_SAMPLE_SIZE) {
    const raw = clip((features.openingRangeBreakoutProbability - 0.5) * 2);
    const contribution = WEIGHTS.openingRangeEdge * raw;
    logit += contribution;
    factors.push({
      name: "openingRangeEdge",
      contribution,
      description: `the first-hour range has broken in this direction ${(features.openingRangeBreakoutProbability * 100).toFixed(0)}% of the last ${features.openingRangeSampleSize} sessions`,
    });
  }

  const probability = 1 / (1 + Math.exp(-logit));
  return { probability: Math.round(probability * 1e5) / 1e5, factors };
}
