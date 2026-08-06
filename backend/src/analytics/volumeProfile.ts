/**
 * Volume-at-price profile, built from OHLCV bars (not true tick-by-tick
 * trade prices, which this app doesn't have) -- each bar's volume is spread
 * evenly across the price buckets its high-low range touches, the standard
 * approximation for building a profile from bar data instead of a true
 * footprint chart. Feeds the Execution Decision Engine's fair-value map:
 * Point of Control (POC), Value Area High/Low (VAH/VAL), and high/low
 * volume nodes (HVN/LVN).
 */
import type { OhlcBar } from "../regime/indicators.js";

export interface VolumeProfileLevel {
  price: number;
  volume: number;
}

export interface VolumeProfile {
  levels: VolumeProfileLevel[]; // sorted ascending by price
  poc: number | null;
  valueAreaHigh: number | null;
  valueAreaLow: number | null;
  /** Prices with volume well above average -- likely support/resistance shelves. */
  highVolumeNodes: number[];
  /** Prices with volume well below average -- price tends to move quickly through these. */
  lowVolumeNodes: number[];
}

const EMPTY_PROFILE: VolumeProfile = { levels: [], poc: null, valueAreaHigh: null, valueAreaLow: null, highVolumeNodes: [], lowVolumeNodes: [] };

// Hand-set (not fitted): 70% is the conventional Value Area definition used
// across Market Profile literature, not specific to this instrument/strategy.
const DEFAULT_VALUE_AREA_PCT = 0.7;
// A node needs to be at least 50% above/below the mean bucket volume to
// count as a high/low volume node -- a deliberately loose bar so both
// categories are non-empty on ordinary data, not a validated threshold.
const HVN_MULTIPLIER = 1.5;
const LVN_MULTIPLIER = 0.5;

export function computeVolumeProfile(bars: OhlcBar[], bucketSize: number, valueAreaPct = DEFAULT_VALUE_AREA_PCT): VolumeProfile {
  if (bars.length === 0 || bucketSize <= 0) return EMPTY_PROFILE;

  const buckets = new Map<number, number>();
  for (const bar of bars) {
    const lowBucket = Math.floor(bar.low / bucketSize) * bucketSize;
    const highBucket = Math.floor(bar.high / bucketSize) * bucketSize;
    const bucketCount = Math.round((highBucket - lowBucket) / bucketSize) + 1;
    const volumePerBucket = bar.volume / bucketCount;
    for (let i = 0; i < bucketCount; i++) {
      const key = Math.round((lowBucket + i * bucketSize) / bucketSize) * bucketSize;
      buckets.set(key, (buckets.get(key) ?? 0) + volumePerBucket);
    }
  }

  const levels = [...buckets.entries()].map(([price, volume]) => ({ price, volume })).sort((a, b) => a.price - b.price);
  if (levels.length === 0) return EMPTY_PROFILE;

  let pocIndex = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i]!.volume > levels[pocIndex]!.volume) pocIndex = i;
  }
  const poc = levels[pocIndex]!.price;

  // Value area: expand outward from POC, each step adding whichever
  // adjacent side has more volume, until valueAreaPct of total is covered.
  const totalVolume = levels.reduce((sum, l) => sum + l.volume, 0);
  let coveredVolume = levels[pocIndex]!.volume;
  let lowIdx = pocIndex;
  let highIdx = pocIndex;
  while (coveredVolume < totalVolume * valueAreaPct && (lowIdx > 0 || highIdx < levels.length - 1)) {
    const belowVolume = lowIdx > 0 ? levels[lowIdx - 1]!.volume : -1;
    const aboveVolume = highIdx < levels.length - 1 ? levels[highIdx + 1]!.volume : -1;
    if (aboveVolume >= belowVolume && highIdx < levels.length - 1) {
      highIdx++;
      coveredVolume += levels[highIdx]!.volume;
    } else if (lowIdx > 0) {
      lowIdx--;
      coveredVolume += levels[lowIdx]!.volume;
    } else {
      break;
    }
  }

  const meanVolume = totalVolume / levels.length;
  const highVolumeNodes = levels.filter((l) => l.volume > meanVolume * HVN_MULTIPLIER).map((l) => l.price);
  const lowVolumeNodes = levels.filter((l) => l.volume < meanVolume * LVN_MULTIPLIER).map((l) => l.price);

  return {
    levels,
    poc,
    valueAreaHigh: levels[highIdx]!.price,
    valueAreaLow: levels[lowIdx]!.price,
    highVolumeNodes,
    lowVolumeNodes,
  };
}
