/**
 * Smart entry positioning (2026-08-09, operator request, replacing the
 * Execution Decision Engine's removed resting-order/re-rank machinery with a
 * one-shot version): instead of resting a limit order at the exact bar close
 * a setup was scored at, look at the last 6 five-minute candles' volume
 * profile and VWAP, and rest at whichever real, backtestable reference
 * (point of control, then VWAP) offers a genuine discount (long) or premium
 * (short) versus the signal price -- "the strongest place to profit," not
 * just "wherever price happened to be at the instant of scoring."
 *
 * Deliberately volume-profile/VWAP only, not live order-flow (operator's
 * explicit choice over the order-flow-listener alternative): pure OHLCV math
 * means this runs identically live and in replay (see
 * .claude/rules/replay-harness.md), unlike CDP order flow, which can never
 * be backfilled.
 *
 * One-shot, not persistent: computed once when a setup reaches risk
 * assessment (risk/engine.ts's assessNewTrade already takes entryPrice as a
 * plain parameter), not a resting state machine that re-ranks as new bars
 * arrive -- operator's explicit call against rebuilding EDE's complexity.
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import { aggregateBars } from "./intradayEmaProximity.js";
import { computeVolumeProfile } from "./volumeProfile.js";
import { computeRollingVwap } from "./vwap.js";

const CANDLE_MINUTES = 5;
const LOOKBACK_CANDLES = 6;

export interface SmartEntryResult {
  entryPrice: Decimal;
  basis: "poc" | "vwap" | "signal_price";
  reason: string;
}

function roundToTick(price: number, tickSize: Decimal): Decimal {
  const raw = new Decimal(price);
  if (tickSize.lte(0)) return raw;
  return raw.dividedBy(tickSize).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(tickSize);
}

/**
 * `structureSwingPrice`, when provided, is the same structure-vs-ATR
 * reference risk/stops.ts's computeInitialStop uses for the stop itself --
 * a discount/premium is only ever accepted up to that level, never past it,
 * so the eventual stop can't end up on the wrong side of entry.
 */
export function computeSmartEntryPrice(
  bars: OhlcBar[],
  side: "long" | "short",
  signalPrice: Decimal,
  atrValue: Decimal,
  tickSize: Decimal,
  structureSwingPrice: Decimal | null
): SmartEntryResult {
  const fiveMinCandles = aggregateBars(bars, CANDLE_MINUTES).slice(-LOOKBACK_CANDLES);
  if (fiveMinCandles.length < LOOKBACK_CANDLES) {
    return { entryPrice: signalPrice, basis: "signal_price", reason: `fewer than ${LOOKBACK_CANDLES} five-minute candles available yet -- resting at the signal price` };
  }

  const signal = signalPrice.toNumber();
  const structure = structureSwingPrice?.toNumber() ?? null;

  const isFavorable = (price: number): boolean => {
    const betterThanSignal = side === "long" ? price <= signal : price >= signal;
    if (!betterThanSignal) return false;
    if (structure === null) return true;
    // Never rest beyond the structural stop reference itself -- that would
    // put the eventual stop on the wrong side of entry.
    return side === "long" ? price >= structure : price <= structure;
  };

  // Bucket size scales with ATR (same ratio fairValueMap.ts used) so the
  // profile stays reasonably grained across both a calm and volatile regime.
  const bucketSize = Math.max(atrValue.toNumber() / 20, tickSize.toNumber());
  const volumeProfile = computeVolumeProfile(fiveMinCandles, bucketSize);
  const vwap = computeRollingVwap(fiveMinCandles, LOOKBACK_CANDLES);

  if (volumeProfile.poc !== null && isFavorable(volumeProfile.poc)) {
    return {
      entryPrice: roundToTick(volumeProfile.poc, tickSize),
      basis: "poc",
      reason: `${LOOKBACK_CANDLES}x${CANDLE_MINUTES}m volume point of control (${volumeProfile.poc.toFixed(2)}) is a favorable ${side === "long" ? "discount" : "premium"} vs the ${signal.toFixed(2)} signal price`,
    };
  }
  if (vwap !== null && isFavorable(vwap)) {
    return {
      entryPrice: roundToTick(vwap, tickSize),
      basis: "vwap",
      reason: `rolling ${LOOKBACK_CANDLES}x${CANDLE_MINUTES}m VWAP (${vwap.toFixed(2)}) is a favorable ${side === "long" ? "discount" : "premium"} vs the ${signal.toFixed(2)} signal price`,
    };
  }
  return {
    entryPrice: signalPrice,
    basis: "signal_price",
    reason: `neither the volume point of control nor VWAP offered a ${side === "long" ? "discount" : "premium"} vs the signal price -- resting at the signal price`,
  };
}
