/**
 * Fair Value Map -- Phase 2 of the Execution Decision Engine: every
 * meaningful reference level/reading around current price, assembled once
 * per evaluation so the Entry Quality Model (entryQualityModel.ts) can
 * score a whole price ladder against it without recomputing each input per
 * candidate price.
 */
import type { OhlcBar } from "../regime/indicators.js";
import { computeSupportResistanceLevels, type SrLevel } from "../analytics/supportResistance.js";
import { computeVolumeProfile, type VolumeProfile } from "../analytics/volumeProfile.js";
import { computeSessionVwap, computeRollingVwap } from "../analytics/vwap.js";
import { computeBollingerBands, type BollingerBands } from "../analytics/bollingerBands.js";
import { computeKeltnerChannels, type KeltnerChannels } from "../analytics/keltnerChannels.js";
import { detectAbsorption, detectDeltaDivergence, type AbsorptionReading, type DeltaDivergence } from "../analytics/orderFlowAbsorption.js";
import { lastRsi } from "../analytics/rsi.js";
import type { OrderFlowHistoryPoint } from "../engine/liveOrderFlowCache.js";

export interface FairValueMap {
  currentPrice: number;
  atrValue: number;
  srLevels: SrLevel[];
  volumeProfile: VolumeProfile;
  sessionVwap: number | null;
  rollingVwap: number | null;
  bollinger: BollingerBands | null;
  keltner: KeltnerChannels | null;
  absorption: AbsorptionReading;
  deltaDivergence: DeltaDivergence;
  rsi: number | null;
}

// Rolling VWAP window -- hand-set at 60 bars (roughly the last hour on
// 1-minute bars), a faster-reacting complement to the session anchor.
const ROLLING_VWAP_LOOKBACK_BARS = 60;
// EDE's faster-moving readings (order flow, momentum, volatility) all
// consolidated onto one consistent 15-minute lookback (2026-07-23, operator
// request) -- previously a scattered mix of 5/10/14/20-minute windows, too
// short and too noisy for a best-price decision. Rolling VWAP (above,
// ~hourly) and session VWAP/S-R/volume-profile (fairValueMap.ts's own full
// bars window, several hours) are deliberately untouched -- those already
// serve a genuinely longer-horizon role, not the "too short" complaint this
// addresses.
const FAST_FACTOR_LOOKBACK_MINUTES = 15;
const ORDER_FLOW_LOOKBACK = FAST_FACTOR_LOOKBACK_MINUTES;
const DELTA_DIVERGENCE_LOOKBACK = FAST_FACTOR_LOOKBACK_MINUTES;

export function buildFairValueMap(
  bars: OhlcBar[],
  currentPrice: number,
  atrValue: number,
  orderFlowHistory: OrderFlowHistoryPoint[]
): FairValueMap {
  const lastBar = bars.at(-1);
  // Volume profile bucket size scales with ATR (roughly ATR/20) so the
  // number of buckets stays reasonable across both a calm and volatile
  // regime, rather than a fixed point value that's too coarse or too fine
  // depending on conditions. Hand-set ratio, not fitted.
  const bucketSize = Math.max(atrValue / 20, 0.01);

  return {
    currentPrice,
    atrValue,
    srLevels: computeSupportResistanceLevels(bars, currentPrice, atrValue),
    volumeProfile: computeVolumeProfile(bars, bucketSize),
    sessionVwap: computeSessionVwap(bars),
    rollingVwap: computeRollingVwap(bars, ROLLING_VWAP_LOOKBACK_BARS),
    bollinger: computeBollingerBands(bars, FAST_FACTOR_LOOKBACK_MINUTES),
    keltner: computeKeltnerChannels(bars),
    absorption: lastBar ? detectAbsorption(orderFlowHistory, lastBar, ORDER_FLOW_LOOKBACK) : { detected: false, side: null, description: "no bars" },
    deltaDivergence: detectDeltaDivergence(orderFlowHistory, bars, DELTA_DIVERGENCE_LOOKBACK),
    rsi: lastRsi(bars, FAST_FACTOR_LOOKBACK_MINUTES),
  };
}
