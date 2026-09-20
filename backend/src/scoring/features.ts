/**
 * Feature vector construction for a candidate trade setup.
 *
 * Shared by both the v1 rule-based scorer and the offline ML training
 * pipeline, so a model trained later sees exactly the same features the live
 * rule scorer used to generate the trades it's training on.
 */
import { atr, realizedVolZscore, type OhlcBar } from "../regime/indicators.js";
import type { RegimeResult } from "../regime/classifier.js";
import { classifyLiquidity, classifyMarketStructure, describePriceAction, type LiquidityLabel, type MarketStructureLabel, type PriceActionLabel } from "../analytics/priceAction.js";
import { classifySession, type TradingSession } from "../analytics/session.js";
import { findSwing } from "../analytics/fibonacci.js";
import { computePpm } from "../analytics/ppm.js";
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";
import { computeEma20Ema200Regime, type EmaTrend, type Ema20Ema200Regime } from "../analytics/emaTrend.js";
import { intraday5mEmaDistanceAtr } from "../analytics/intradayEmaProximity.js";

export interface SetupFeatures {
  symbol: string;
  side: "long" | "short";
  momentum10: number | null;
  atrNormalizedRange: number | null;
  distanceFromMa20Atr: number | null;
  volumeZscore: number | null;
  realizedVolZscore: number | null;
  trendLabel: string;
  volLabel: string;
  regimeConfidence: number;
  adx: number | null;
  slopeR2: number | null;
  hourOfDayUtc: number;
  isRthSession: boolean;
  newsRiskFlag: boolean;
  newsMinutesToEvent: number | null;
  strategyHistoricalWinRate: number | null;
  /** Empirical probability (from computeOpeningRangeStats) that the first-hour range gets broken in this setup's direction. */
  openingRangeBreakoutProbability: number | null;
  /** How many historical sessions that probability is based on -- lets the scorer ignore it until there's enough data to trust it. */
  openingRangeSampleSize: number;
  /** Trading session at signal time -- also stored as its own indexed Score column, kept here too for convenience when reading the raw features blob. */
  session: TradingSession;
  marketStructureLabel: MarketStructureLabel;
  liquidityLabel: LiquidityLabel;
  priceActionLabel: PriceActionLabel;
  /** Higher-timeframe trend (computed from ~1yr of daily bars, see engine/dailyTrendCache.ts) -- much stickier than the intraday regime, used to filter out countertrend whipsaw. */
  dailyTrendLabel: "up" | "down" | "none";
  dailyTrendConfidence: number;
  /** Empirical win rate (see engine/fixedTargetEdgeCache.ts) that a LONG setup in this exact (symbol, session) bucket has historically reached a fixed +20pt move before its stop. Null until there's at least one resolved sample. */
  longTargetWinRate: number | null;
  longTargetSampleSize: number;
  /** Hypothetical take-profit distance / stop distance for this setup's initial stop plan (see risk/tradePlan.ts's 1:3 floor) -- every scoring version factors this in as a certainty input, not just an execution-time sizing rule. Null if a stop plan couldn't be computed. */
  riskRewardRatio: number | null;
  /** Direction of the most recent swing (see analytics/fibonacci.ts's findSwing) over a shorter recent lookback than the full bar window -- used to validate a setup's side against the swing structure it's actually inside of. Null if there aren't enough bars for a swing. */
  fibSwingDirection: "up" | "down" | null;
  /** How deep into the swing's retracement the current close sits: 0 = right at the swing's most recent extreme (no pullback yet), 1 = fully round-tripped to the opposite extreme (swing structure likely broken). Matches computeFibLevels' 0%/100% convention. Null if there's no valid swing. */
  fibRetracementPct: number | null;
  /** Signed points-per-minute over a rolling 15-minute window (see analytics/ppm.ts) -- positive means the market is currently moving up, negative down, independent of the setup's side. Null if there aren't at least 2 ticks in the window. */
  netPointsPerMinute: number | null;
  /** Most recent live order-flow read for this symbol (see browserWatch/orderFlowListener.ts and analytics/orderFlow.ts) -- trade-aggressor buy/sell volume and resting bid/ask size from the last flush window, plus TopstepX's crowd "Tilt" bias. Null when the order-flow listener isn't running (PRICE_SOURCE != browser or ORDER_FLOW_ENABLED=false) or hasn't produced a snapshot for this symbol yet. */
  orderFlowSnapshot: OrderFlowSnapshot | null;
  /** Daily-chart EMA(20) trend + slope (see engine/dailyEmaTrendCache.ts) -- v3's sole trend-direction input (scoring/ruleScorerV3.ts's "trend direction" factor). Computed from daily closes, not the intraday bars a strategy trades on. */
  dailyEma20Trend: EmaTrend;
  /** Signed distance (in ATR) from current price to a fast intraday 20-EMA on 5-minute bars (see analytics/intradayEmaProximity.ts) -- positive means price is above the EMA, negative below. Null until there are at least 20 five-minute bars or ATR isn't available. */
  intraday5mEmaDistanceAtr: number | null;
  /** Which side of the 20/200 EMA crossover price currently sits on, computed on this same bar series (see analytics/emaTrend.ts's computeEma20Ema200Regime) -- distinct from intraday5mEmaDistanceAtr's fast-20-EMA-only proximity read and from dailyEma20Trend's daily-bar signal. Null until there are at least 200 bars for a real slow EMA. */
  ema20Ema200Regime: Ema20Ema200Regime;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function buildSetupFeatures(
  bars: OhlcBar[],
  symbol: string,
  side: "long" | "short",
  regime: RegimeResult,
  now: Date,
  newsRiskFlag: boolean,
  newsMinutesToEvent: number | null,
  strategyHistoricalWinRate: number | null = null,
  openingRangeBreakoutProbability: number | null = null,
  openingRangeSampleSize = 0,
  dailyTrendLabel: "up" | "down" | "none" = "none",
  dailyTrendConfidence = 0,
  longTargetWinRate: number | null = null,
  longTargetSampleSize = 0,
  riskRewardRatio: number | null = null,
  orderFlowSnapshot: OrderFlowSnapshot | null = null,
  dailyEma20Trend: EmaTrend = { ema: null, slope: null, label: "neutral" }
): SetupFeatures {
  const closes = bars.map((b) => b.close);
  const atrSeries = atr(bars).filter((v) => !Number.isNaN(v));
  const lastAtr = atrSeries.length ? atrSeries[atrSeries.length - 1]! : null;

  let momentum10: number | null = null;
  if (closes.length > 10) {
    const past = closes[closes.length - 11]!;
    momentum10 = past !== 0 ? (closes[closes.length - 1]! - past) / past : null;
  }

  let atrNormalizedRange: number | null = null;
  if (lastAtr && lastAtr > 0) {
    const lastBar = bars[bars.length - 1]!;
    atrNormalizedRange = (lastBar.high - lastBar.low) / lastAtr;
  }

  let distanceFromMa20Atr: number | null = null;
  if (lastAtr && lastAtr > 0 && closes.length >= 20) {
    const sma20 = mean(closes.slice(-20));
    distanceFromMa20Atr = (closes[closes.length - 1]! - sma20) / lastAtr;
  }

  let volumeZscore: number | null = null;
  if (bars.length >= 50) {
    const volumes = bars.map((b) => b.volume).slice(-50);
    const m = mean(volumes);
    const std = Math.sqrt(mean(volumes.map((v) => (v - m) ** 2)));
    if (std) volumeZscore = (bars[bars.length - 1]!.volume - m) / std;
  }

  const rvZseries = realizedVolZscore(bars).filter((v) => !Number.isNaN(v));
  const rvZ = rvZseries.length ? rvZseries[rvZseries.length - 1]! : null;

  const hour = now.getUTCHours();
  const isRth = hour >= 13 && hour < 20; // ~9:30am-4pm ET in UTC, ignoring DST nuance

  const session = classifySession(now);
  const marketStructureLabel = classifyMarketStructure(regime);
  const liquidityLabel = classifyLiquidity(volumeZscore, session);
  const priceActionLabel = describePriceAction(bars);

  // Shorter than the full `bars` window (typically 300) so the swing found
  // is the current, still-relevant one rather than the single most extreme
  // high/low anywhere in a long history.
  const FIB_SWING_LOOKBACK_BARS = 100;
  const swing = findSwing(bars.slice(-FIB_SWING_LOOKBACK_BARS));
  let fibSwingDirection: "up" | "down" | null = null;
  let fibRetracementPct: number | null = null;
  if (swing) {
    fibSwingDirection = swing.direction;
    const range = swing.high - swing.low;
    if (range > 0) {
      const lastClose = closes[closes.length - 1]!;
      fibRetracementPct = swing.direction === "up" ? (swing.high - lastClose) / range : (lastClose - swing.low) / range;
    }
  }

  const PPM_WINDOW_MINUTES = 15;
  const ppm = computePpm(bars, PPM_WINDOW_MINUTES);
  const netPointsPerMinute = ppm.sampleCount >= 2 ? ppm.netPointsPerMinute : null;

  const intraday5mEmaDistance = intraday5mEmaDistanceAtr(bars, lastAtr);
  const ema20Ema200Regime = computeEma20Ema200Regime(bars);

  return {
    symbol,
    side,
    momentum10,
    atrNormalizedRange,
    distanceFromMa20Atr,
    volumeZscore,
    realizedVolZscore: rvZ,
    trendLabel: regime.trendLabel,
    volLabel: regime.volLabel,
    regimeConfidence: regime.confidence,
    adx: regime.features.adx ?? null,
    slopeR2: regime.features.slopeR2 ?? null,
    hourOfDayUtc: hour,
    isRthSession: isRth,
    newsRiskFlag,
    newsMinutesToEvent,
    strategyHistoricalWinRate,
    openingRangeBreakoutProbability,
    openingRangeSampleSize,
    session,
    marketStructureLabel,
    liquidityLabel,
    priceActionLabel,
    dailyTrendLabel,
    dailyTrendConfidence,
    longTargetWinRate,
    longTargetSampleSize,
    riskRewardRatio,
    fibSwingDirection,
    fibRetracementPct,
    netPointsPerMinute,
    orderFlowSnapshot,
    dailyEma20Trend,
    intraday5mEmaDistanceAtr: intraday5mEmaDistance,
    ema20Ema200Regime,
  };
}
