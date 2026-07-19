/**
 * Rule-based trade-scoring models: documented, weighted heuristics, not a
 * black box. Every factor's contribution is returned alongside the score so
 * the explanation engine can say *why* a setup scored the way it did.
 *
 * Two versions run in parallel on every signal (shadow scoring, see
 * engine/loop.ts) so their performance stays directly comparable over the
 * exact same market conditions -- only SystemState.activeStrategyVersion
 * controls which one's decisions actually reach execution.
 *
 * - v1: the original scorer. Trend/momentum/volatility/news/historical-edge/
 *   opening-range factors. Left unchanged as the baseline to compare against.
 * - v2: v1 plus two new factors -- marketStructureEdge and liquidityEdge --
 *   added after `/api/analytics/session-performance` showed real, sizable
 *   win-rate gaps by marketStructureLabel and liquidityLabel that v1 never
 *   used at all despite collecting them on every row. Directionally set from
 *   the observed gaps (e.g. "ranging" structure was the worst-performing,
 *   highest-volume bucket in both sessions; "high" liquidity meaningfully
 *   outperformed "normal"/"low"), not a fitted regression -- same
 *   hand-set-prior philosophy as the rest of this scorer, just informed by
 *   real data instead of a starting guess.
 */
import type { SetupFeatures } from "./features.js";
import { fibDirectionSignal } from "../analytics/fibonacci.js";
import { ppmDirectionSignal } from "../analytics/ppm.js";
import { timeframeAlignmentSignal } from "../analytics/timeframeAlignment.js";

// "v4" is retained in this union even though it's no longer an active
// voter (removed 2026-07-15, see engine/loop.ts) -- historical Score rows
// still carry strategyVersion: "v4" and need to keep typechecking. The
// training pipeline behind it (scoring/training.ts) is left in place,
// dormant, in case it's revisited later.
export type StrategyVersion = "v1" | "v2" | "v3" | "v4";

// Weights are hand-set, documented priors -- not fit to data. Magnitudes
// reflect how strongly each factor should move the pre-threshold
// probability; news risk dominates deliberately (never assume a clean setup
// outweighs event risk).
const WEIGHTS_V1 = {
  trendAlignment: 1.1,
  // Replaces the old single-timeframe dailyTrendAlignment (2026-07-18,
  // operator request) -- 1D is now the heaviest-weighted leg inside this
  // composite instead of a separate factor scoring the same daily-trend
  // evidence twice. Weighted above the old 1.8: full agreement now needs
  // corroboration across up to 7 legs (1D down to 1M, see
  // analytics/timeframeAlignment.ts) instead of just one. Hand-set, like
  // every other weight here -- worth revisiting once real 4h/1h rollup data
  // has accumulated for a few weeks and score distributions can actually be
  // observed (bars_1m only recently started accumulating clean history, see
  // marketData/rollup.ts, so those two legs are omitted from the composite
  // until then rather than scored on thin/no data).
  timeframeAlignment: 2.2,
  momentumAlignment: 0.8,
  adxStrength: 0.6,
  volatilityRegime: 0.5,
  volumeConfirmation: 0.4,
  session: 0.3,
  newsRisk: 1.6,
  historicalEdge: 0.9,
  openingRangeEdge: 0.7,
  riskRewardEdge: 0.6,
  fibDirectionEdge: 0.8,
  // Set so this weight alone is ~10% of the total weight sum (2026-07-15,
  // operator request) -- with every other weight fixed, ppmEdge=1.1 makes
  // 1.1 / (sum of all weights) land at ~10%.
  ppmEdge: 1.1,
};

// Setups are centered on the 1:3 risk/reward floor already enforced at
// execution time (risk/tradePlan.ts's MIN_RISK_REWARD_DENOMINATOR) -- a
// setup exactly at that floor is neutral, a materially better reward-to-risk
// shape is rewarded, and a worse one (before the execution-time floor would
// widen the stop) is penalized. Capped at 2x the floor either direction so
// one outlier ratio can't dominate the score.
const RISK_REWARD_FLOOR = 3;
const RISK_REWARD_SPAN = 3;

const WEIGHTS_V2 = {
  ...WEIGHTS_V1,
  marketStructureEdge: 1.3,
  liquidityEdge: 0.7,
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

export function scoreSetup(features: SetupFeatures, version: StrategyVersion = "v1"): ScoreResult {
  const direction = features.side === "long" ? 1 : -1;
  const factors: FactorContribution[] = [];
  const weights = version === "v2" ? WEIGHTS_V2 : WEIGHTS_V1;
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
    const contribution = weights.trendAlignment * raw;
    logit += contribution;
    factors.push({ name: "trendAlignment", contribution, description: desc });
  }

  // 2. Multi-timeframe trend alignment -- 1D down to 1M combined, weighted so
  // higher timeframes count more (analytics/timeframeAlignment.ts has the
  // exact per-leg weights/math). The intraday regime used by factor #1 above
  // can flip within a single session as short-term noise passes through;
  // folding 1D (still the heaviest leg) in alongside 4H/1H/30M/15M/5M/1M
  // keeps this factor's original whipsaw-defense role while correctly
  // softening when higher and lower timeframes genuinely disagree, rather
  // than a same-session intraday flip being invisible to a single fixed
  // daily read the way the old dailyTrendAlignment factor was.
  {
    const raw = timeframeAlignmentSignal(features.timeframeTrends, features.side);
    const contribution = weights.timeframeAlignment * raw;
    logit += contribution;
    const available = Object.keys(features.timeframeTrends).length;
    factors.push({
      name: "timeframeAlignment",
      contribution,
      description: `multi-timeframe trend alignment across ${available}/7 available timeframes (${raw >= 0 ? "supports" : "fights"} a ${features.side} setup)`,
    });
  }

  // 3. Momentum alignment
  if (features.momentum10 !== null) {
    const raw = clip(direction * features.momentum10 * 20);
    const desc = raw > 0 ? "recent momentum supports the setup" : "recent momentum opposes the setup";
    const contribution = weights.momentumAlignment * raw;
    logit += contribution;
    factors.push({ name: "momentumAlignment", contribution, description: desc });
  }

  // 4. ADX trend strength (only rewarded when trend is aligned)
  if (features.adx !== null && features.trendLabel !== "none") {
    const aligned = (features.trendLabel === "up") === (direction === 1);
    const raw = aligned ? clip((features.adx - 20) / 30) : 0;
    if (raw) {
      const contribution = weights.adxStrength * raw;
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
    const contribution = weights.volatilityRegime * raw;
    logit += contribution;
    factors.push({ name: "volatilityRegime", contribution, description: desc });
  }

  // 6. Volume confirmation
  if (features.volumeZscore !== null) {
    const momentumAligned = direction * (features.momentum10 ?? 0) >= 0;
    const raw = momentumAligned ? clip(features.volumeZscore / 2) : 0;
    if (raw) {
      const contribution = weights.volumeConfirmation * raw;
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
    const contribution = weights.session * raw;
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
    const contribution = weights.newsRisk * raw;
    logit += contribution;
    factors.push({ name: "newsRisk", contribution, description: "a high-impact news event is imminent or just released" });
  }

  // 9. Strategy's own historical edge, if we have enough trades to know it
  if (features.strategyHistoricalWinRate !== null) {
    const raw = clip((features.strategyHistoricalWinRate - 0.5) * 2);
    const contribution = weights.historicalEdge * raw;
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
    const contribution = weights.openingRangeEdge * raw;
    logit += contribution;
    factors.push({
      name: "openingRangeEdge",
      contribution,
      description: `the first-hour range has broken in this direction ${(features.openingRangeBreakoutProbability * 100).toFixed(0)}% of the last ${features.openingRangeSampleSize} sessions`,
    });
  }

  // 10b. Risk/reward edge -- every version scores this, not just v2+. Loose
  // nullish check (not `!== null`) since features can come from JSON-
  // deserialized DB rows or partial test fixtures where the field is simply
  // absent (undefined), not explicitly null.
  if (features.riskRewardRatio != null) {
    const raw = clip((features.riskRewardRatio - RISK_REWARD_FLOOR) / RISK_REWARD_SPAN);
    const contribution = weights.riskRewardEdge * raw;
    logit += contribution;
    factors.push({
      name: "riskRewardEdge",
      contribution,
      description: `hypothetical reward:risk is ${features.riskRewardRatio.toFixed(2)}:1 (vs the ${RISK_REWARD_FLOOR}:1 floor)`,
    });
  }

  // 10c. Fibonacci direction validation -- every version scores this. See
  // analytics/fibonacci.ts's fibDirectionSignal for the -1..1 scale: fighting
  // the recent swing's direction is penalized, aligning with it is rewarded,
  // most of all when price sits in the classic 38.2%-61.8% pullback zone
  // rather than chasing (barely pulled back) or arriving after the swing
  // structure has likely already broken (deep retracement).
  {
    const raw = fibDirectionSignal(features.fibSwingDirection ?? null, features.fibRetracementPct ?? null, features.side);
    const contribution = weights.fibDirectionEdge * raw;
    logit += contribution;
    const pct = features.fibRetracementPct != null ? `${(features.fibRetracementPct * 100).toFixed(0)}% retracement` : "no retracement reading";
    factors.push({
      name: "fibDirectionEdge",
      contribution,
      description: features.fibSwingDirection
        ? `${features.fibSwingDirection} swing, ${pct} -- ${raw >= 0 ? "supports" : "fights"} a ${features.side} setup`
        : "not enough bars for a swing reading",
    });
  }

  // 10d. Points-per-minute direction -- every version scores this, ~10% of
  // total factor weight (2026-07-15, operator request). See analytics/ppm.ts's
  // ppmDirectionSignal: positive when current market speed is moving in this
  // setup's favor, negative when it opposes.
  {
    const raw = ppmDirectionSignal(features.netPointsPerMinute ?? null, features.side);
    const contribution = weights.ppmEdge * raw;
    logit += contribution;
    factors.push({
      name: "ppmEdge",
      contribution,
      description:
        features.netPointsPerMinute != null
          ? `market moving ${features.netPointsPerMinute >= 0 ? "up" : "down"} at ${Math.abs(features.netPointsPerMinute).toFixed(2)} pts/min -- ${raw >= 0 ? "supports" : "opposes"} a ${features.side} setup`
          : "not enough recent ticks for a points-per-minute reading",
    });
  }

  if (version === "v2") {
    // 11. Market structure edge -- session-performance data showed "ranging"
    // structure was the worst-performing bucket in both New York (13.5% win
    // rate) and Asian (19.8%) sessions, while also being the highest-volume
    // bucket by far (~80% of all setups) -- v1 never penalized this beyond
    // the much coarser, intraday-only trendLabel factor above.
    {
      let raw: number;
      let desc: string;
      switch (features.marketStructureLabel) {
        case "ranging":
          raw = -0.9;
          desc = "market structure is ranging -- the weakest-performing structure bucket historically";
          break;
        case "strong_uptrend":
        case "strong_downtrend": {
          const alignedStrong =
            (features.marketStructureLabel === "strong_uptrend" && direction === 1) ||
            (features.marketStructureLabel === "strong_downtrend" && direction === -1);
          raw = alignedStrong ? 0.6 : -0.6;
          desc = alignedStrong ? `market structure (${features.marketStructureLabel}) agrees with the setup` : `market structure (${features.marketStructureLabel}) opposes the setup`;
          break;
        }
        default: {
          // weak_uptrend / weak_downtrend
          const alignedWeak =
            (features.marketStructureLabel === "weak_uptrend" && direction === 1) ||
            (features.marketStructureLabel === "weak_downtrend" && direction === -1);
          raw = alignedWeak ? 0.3 : -0.3;
          desc = alignedWeak ? `market structure (${features.marketStructureLabel}) agrees with the setup` : `market structure (${features.marketStructureLabel}) opposes the setup`;
        }
      }
      const contribution = WEIGHTS_V2.marketStructureEdge * raw;
      logit += contribution;
      factors.push({ name: "marketStructureEdge", contribution, description: desc });
    }

    // 12. Liquidity edge -- "high" liquidity outperformed "normal"/"low" by a
    // wide margin in both sessions (NY: 27.6% vs 14.7%; Asian: 29.3% vs
    // 20.6%) -- a dimension v1 collected but never scored on at all.
    {
      let raw: number;
      let desc: string;
      if (features.liquidityLabel === "high") {
        raw = 0.6;
        desc = "high liquidity has historically outperformed in this session";
      } else if (features.liquidityLabel === "low") {
        raw = -0.2;
        desc = "low liquidity, thinner participation";
      } else {
        raw = -0.1;
        desc = "normal liquidity";
      }
      const contribution = WEIGHTS_V2.liquidityEdge * raw;
      logit += contribution;
      factors.push({ name: "liquidityEdge", contribution, description: desc });
    }
  }

  const probability = 1 / (1 + Math.exp(-logit));
  return { probability: Math.round(probability * 1e5) / 1e5, factors };
}
