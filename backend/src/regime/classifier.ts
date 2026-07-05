/**
 * Combines indicators into a (trend, volatility) regime label + confidence.
 *
 * Trend axis: "up" | "down" | "none" (ranging)
 * Vol axis:   "high" | "normal" | "low"
 *
 * Thresholds are conservative, documented defaults -- tune per-instrument once
 * enough regime_history/trade data accumulates.
 */
import { adx, atrPercentile, bollingerBandwidth, choppinessIndex, lastValid, trendSlopeR2, type OhlcBar } from "./indicators.js";

const ADX_TREND_THRESHOLD = 25.0;
const CHOPPINESS_RANGE_THRESHOLD = 61.8; // classic Choppiness Index range-market threshold
const SLOPE_R2_CONFIRM_THRESHOLD = 0.4;
const VOL_HIGH_PERCENTILE = 0.7;
const VOL_LOW_PERCENTILE = 0.3;

export interface RegimeResult {
  trendLabel: "up" | "down" | "none";
  volLabel: "high" | "normal" | "low";
  confidence: number;
  features: Record<string, number | null>;
}

export function classifyRegime(bars: OhlcBar[]): RegimeResult {
  const adxSeries = adx(bars);
  const chopSeries = choppinessIndex(bars);
  const bbwSeries = bollingerBandwidth(bars);
  const { slope, r2 } = trendSlopeR2(bars);
  const atrPctSeries = atrPercentile(bars);

  const lastAdx = lastValid(adxSeries);
  const lastChop = lastValid(chopSeries);
  const lastBbw = lastValid(bbwSeries);
  const lastSlope = lastValid(slope);
  const lastR2 = lastValid(r2);
  const lastAtrPct = lastValid(atrPctSeries);

  const features: Record<string, number | null> = {
    adx: lastAdx,
    choppiness: lastChop,
    bollingerBandwidth: lastBbw,
    slope: lastSlope,
    slopeR2: lastR2,
    atrPercentile: lastAtrPct,
  };

  const isTrending = (lastAdx !== null && lastAdx >= ADX_TREND_THRESHOLD) || (lastChop !== null && lastChop <= 100 - CHOPPINESS_RANGE_THRESHOLD);

  let trendLabel: "up" | "down" | "none";
  let trendConfidence: number;
  if (isTrending && lastSlope !== null && lastR2 !== null && lastR2 >= SLOPE_R2_CONFIRM_THRESHOLD) {
    trendLabel = lastSlope > 0 ? "up" : "down";
    trendConfidence = Math.min(1, (lastAdx ?? 0) / 50) * lastR2;
  } else {
    trendLabel = "none";
    trendConfidence = 1 - Math.min(1, (lastAdx ?? 0) / ADX_TREND_THRESHOLD);
  }

  let volLabel: "high" | "normal" | "low";
  let volConfidence: number;
  if (lastAtrPct === null) {
    volLabel = "normal";
    volConfidence = 0.5;
  } else if (lastAtrPct >= VOL_HIGH_PERCENTILE) {
    volLabel = "high";
    volConfidence = lastAtrPct;
  } else if (lastAtrPct <= VOL_LOW_PERCENTILE) {
    volLabel = "low";
    volConfidence = 1 - lastAtrPct;
  } else {
    volLabel = "normal";
    volConfidence = 0.5;
  }

  const confidence = Math.round(((trendConfidence + volConfidence) / 2) * 10000) / 10000;
  return { trendLabel, volLabel, confidence, features };
}
