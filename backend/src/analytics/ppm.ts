/**
 * "Points per minute" -- how fast the market is actually moving, split into
 * upward and downward speed separately (not just net direction), the way an
 * internet speed test reports upload and download as two independent
 * numbers rather than one net throughput figure.
 *
 * Computed over a rolling 15-minute window of raw price ticks (not a fixed
 * 15-minute candle boundary) so it updates continuously rather than jumping
 * once every 15 minutes -- summing every tick-to-tick up-move and down-move
 * separately captures actual back-and-forth movement a candle's OHLC alone
 * would hide (a candle that nets +2 points could have covered 40 points of
 * whipsaw to get there).
 */
export interface PpmTick {
  time: Date;
  close: number;
}

export interface PpmResult {
  windowMinutes: number; // actual elapsed minutes covered by the data used, up to the requested window
  upPointsPerMinute: number;
  downPointsPerMinute: number;
  netPointsPerMinute: number;
  sampleCount: number;
}

const MIN_ELAPSED_MINUTES = 1 / 60; // 1 second floor, avoids a near-zero divisor from two ticks a moment apart

export function computePpm(ticks: PpmTick[], windowMinutes = 15): PpmResult {
  if (ticks.length < 2) {
    return { windowMinutes: 0, upPointsPerMinute: 0, downPointsPerMinute: 0, netPointsPerMinute: 0, sampleCount: ticks.length };
  }

  let up = 0;
  let down = 0;
  for (let i = 1; i < ticks.length; i++) {
    const delta = ticks[i]!.close - ticks[i - 1]!.close;
    if (delta > 0) up += delta;
    else down += -delta;
  }

  const elapsedMs = ticks[ticks.length - 1]!.time.getTime() - ticks[0]!.time.getTime();
  const elapsedMinutes = Math.min(Math.max(elapsedMs / 60_000, MIN_ELAPSED_MINUTES), windowMinutes);

  return {
    windowMinutes: elapsedMinutes,
    upPointsPerMinute: up / elapsedMinutes,
    downPointsPerMinute: down / elapsedMinutes,
    netPointsPerMinute: (up - down) / elapsedMinutes,
    sampleCount: ticks.length,
  };
}

// 5 points/minute is a hand-set reference for "moving fast" on these
// instruments -- not fitted. Shared by every scoring version so they all
// judge "does current market speed support this setup's side" the same way.
const FAST_POINTS_PER_MINUTE = 5;

/**
 * Normalized [-1, 1] signal for whether current market speed supports a
 * setup's side: positive when net points-per-minute is moving in the
 * setup's favor, negative when it opposes, scaled (and capped) by how fast.
 */
export function ppmDirectionSignal(netPointsPerMinute: number | null, side: "long" | "short"): number {
  if (netPointsPerMinute === null) return 0;
  const signed = side === "long" ? netPointsPerMinute : -netPointsPerMinute;
  return Math.max(-1, Math.min(1, signed / FAST_POINTS_PER_MINUTE));
}
