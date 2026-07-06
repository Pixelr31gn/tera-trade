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
  longTargetSampleSize = 0
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
  };
}
