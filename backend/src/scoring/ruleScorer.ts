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

// "v4" is retained in this union even though it's no longer an active
// voter (removed 2026-07-15, see engine/loop.ts) -- historical Score rows
// still carry strategyVersion: "v4" and need to keep typechecking. The
// training pipeline behind it (scoring/training.ts) is left in place,
// dormant, in case it's revisited later. "v5" (2026-07-21) is deliberately
// NOT a v4 revival -- v4's slot stays reserved for that dormant ML path;
// v5 is a new, real-data-mined rule-based scorer (see ruleScorerV5.ts),
// shadow-scored only (engine/loop.ts's STRATEGY_VERSIONS does not include
// it) until the operator decides it's ready to vote on consensus.
//
// "v6" (2026-08-02, operator spec: "a version that incorporates v1 v2 v3 v5
// with its own buy/sell setup rules") is a different shape again -- not an
// independently mined pattern set like v5, an ENSEMBLE that combines v1/v2/
// v3/v5's own probabilities with strategy/trendPullbackFib.ts's own rule
// check as a confirmation bonus (see ruleScorerV6.ts). Also shadow-scored
// only for now -- same promotion bar as v5, not skipped just because it's
// newer.
export type StrategyVersion = "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7";

// Weights are hand-set, documented priors -- not fit to data. Magnitudes
// reflect how strongly each factor should move the pre-threshold
// probability; news risk dominates deliberately (never assume a clean setup
// outweighs event risk).
const WEIGHTS_V1 = {
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
  riskRewardEdge: 0.6,
  fibDirectionEdge: 0.8,
  // Set so this weight alone is ~10% of the total weight sum (2026-07-15,
  // operator request) -- with every other weight fixed, ppmEdge=1.1 makes
  // 1.1 / (sum of all weights) land at ~10%.
  ppmEdge: 1.1,
  // Hand-set, unproven as a standalone weighted factor -- see
  // analytics/emaTrend.ts's computeEma20Ema200Regime header for the backtest
  // this came from and why that evidence doesn't directly back this specific
  // weight (it tested the regime as a sole hard gate held across an entire
  // regime, not as one bounded input among many at a single setup's signal
  // time -- a materially different, unvalidated claim). Set roughly in line
  // with dailyTrendAlignment's disagreement-penalty scale (a comparable
  // "which side of a higher-timeframe trend is price on" signal) but weighted
  // lower since dailyTrendAlignment has an actual walk-forward result behind
  // it and this doesn't. 2026-08-12, operator request.
  ema20Ema200RegimeEdge: 0.9,
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

  // 2. Daily trend alignment -- the intraday regime above can flip within a
  // single session as short-term noise passes through; the daily trend
  // (computed from ~1yr of daily bars, see engine/dailyTrendCache.ts) is far
  // stickier and is weighted more heavily than the intraday one deliberately,
  // so a setup that fights a confident daily trend rarely clears the score
  // threshold no matter how good it looks on the last few minutes of bars.
  // This is the main defense against long/short/short/long whipsaw.
  //
  // Retuned 2026-08-11 (operator request, after a 12-year daily-bar backfill
  // made this testable for the first time -- see
  // scripts/backtestDailyTrendFactor.ts, BUILD_HISTORY.md). Walk-forward over
  // ES+NQ 2014-2026 (2,896 usable daily samples/symbol, classifyRegime() run
  // over the exact same 200-calendar-day rolling window
  // engine/dailyTrendCache.ts uses live, no look-ahead) found this factor's
  // premise partly backwards:
  //   - dailyTrendLabel="none" days OUTPERFORMED "up" days at every horizon
  //     tested (ES 5-day forward return: none +0.278%/61.0% positive vs.
  //     up +0.085%/58.9% positive) -- the old formula flatly penalized
  //     "none" (-0.2) while rewarding "up" agreement on a rising scale.
  //   - HIGH-CONFIDENCE "up" readings (0.66-1.0 confidence) showed NEGATIVE
  //     mean forward returns at 3-day/5-day horizons on both symbols
  //     (ES: -0.022%/-0.095%, NQ: -0.276%/-0.358%) -- the old
  //     `raw = dailyTrendConfidence` scaling rewarded exactly the readings
  //     this data says were worst.
  //   - dailyTrendLabel="down" showed the strongest positive forward returns
  //     of the three labels, growing stronger at high confidence (ES 5-day
  //     high-confidence: +0.473%/65.1% positive; NQ: +0.973%/68.0%
  //     positive) -- a real mean-reversion pattern the old trend-following
  //     assumption didn't capture.
  // This is a proxy test of the daily-trend SIGNAL alone (unconditional
  // forward drift by label), not a full replay of v1/v2 setups agreeing with
  // or fighting it -- that would need 12 years of 5-minute bars, which don't
  // exist (Yahoo's free feed caps intraday history at ~60 days). Given that
  // gap, the response here is deliberately conservative rather than a full
  // sign flip, and touches only the two branches the evidence actually
  // speaks to: the "none" penalty is softened since the data no longer
  // supports a flat -0.2, and the agreement reward is capped rather than
  // left to scale unbounded with confidence, since higher confidence was not
  // reliably better here (in fact worse, for "up"). The weight itself
  // (1.8) and the disagreement branch are UNCHANGED and deliberately not
  // touched -- an earlier version of this retune halved the shared weight
  // and broke the "fights a confident daily trend even when everything else
  // looks good" gate test below, because that weight also scales the
  // disagreement penalty this factor's whipsaw defense depends on, and
  // there's no evidence here that penalty is wrong. Scoped to v1/v2 only
  // (operator instruction) -- v3 has no equivalent factor. Operator accepted
  // this as lower-stakes than earlier live-gate retunes specifically because
  // v6/v7, not v1/v2's own signal, now carry the forward data-mining
  // workload this factor used to matter more for.
  {
    let raw: number;
    let desc: string;
    if (features.dailyTrendLabel === "none") {
      raw = -0.05;
      desc = "no clear daily trend to confirm this setup's direction";
    } else if ((features.dailyTrendLabel === "up" && direction === 1) || (features.dailyTrendLabel === "down" && direction === -1)) {
      raw = Math.min(features.dailyTrendConfidence, 0.5);
      desc = `agrees with the daily ${features.dailyTrendLabel} trend (${(features.dailyTrendConfidence * 100).toFixed(0)}% confidence)`;
    } else {
      raw = -clip(0.6 + features.dailyTrendConfidence);
      desc = `fights the daily ${features.dailyTrendLabel} trend (${(features.dailyTrendConfidence * 100).toFixed(0)}% confidence)`;
    }
    const contribution = weights.dailyTrendAlignment * raw;
    logit += contribution;
    factors.push({ name: "dailyTrendAlignment", contribution, description: desc });
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

  // 10e. 20/200 EMA crossover regime -- every version scores this, same
  // "shared, not v2-only" family as 10b-10d above. Rewards a setup whose
  // side agrees with which side of the 20/200 EMA crossover price currently
  // sits on (see analytics/emaTrend.ts's computeEma20Ema200Regime), penalizes
  // fighting it. Distinct from trendAlignment (intraday regime classifier)
  // and dailyTrendAlignment (daily-bar higher-timeframe trend) above -- this
  // is specifically the two-EMA-crossover signal the operator asked about.
  {
    let raw: number;
    let desc: string;
    if (features.ema20Ema200Regime === null) {
      raw = 0;
      desc = "not enough bars yet for a 200-period EMA -- no 20/200 crossover reading";
    } else if ((features.ema20Ema200Regime === "bullish" && direction === 1) || (features.ema20Ema200Regime === "bearish" && direction === -1)) {
      raw = 1.0;
      desc = `setup direction agrees with the 20/200 EMA crossover regime (${features.ema20Ema200Regime})`;
    } else {
      raw = -1.0;
      desc = `setup direction fights the 20/200 EMA crossover regime (${features.ema20Ema200Regime})`;
    }
    const contribution = weights.ema20Ema200RegimeEdge * raw;
    logit += contribution;
    factors.push({ name: "ema20Ema200RegimeEdge", contribution, description: desc });
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
