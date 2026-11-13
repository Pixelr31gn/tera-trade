/**
 * 20 MA proximity gate (2026-11-08, operator request: "set up entries to only
 * happen when we are within 5 ticks of the 20 ma"). An entry is allowed only
 * while the current price sits within EMA_PROXIMITY_MAX_TICKS ticks of the
 * 5-minute EMA(20), either side, long or short alike.
 *
 * "20 ma" read as the 5-minute EMA(20): that is what the codebase already
 * calls "the 20 ma" (analytics/intradayEmaProximity.ts, built on the
 * operator's 2026-07-28 "the closer the price is to the 20 ma" request). The
 * 5-tick limit is the operator's number, not a tested one. Append any retune
 * here.
 *
 * 2026-11-09: 5 -> 15 ticks (operator request: "widen the 5 tick to 15").
 * Evidence: from 00:00 to ~07:00 MST that day, 181 consensus signals passed
 * the timeframe alignment gate and all 181 were blocked here -- the closest
 * was 117.5 ticks from the 5m EMA20, median ~394, none within 20. So zero
 * entries for the day. 15 is still the operator's number, not a tested one,
 * and on that day's distances it would not have let any of those 181
 * through either.
 *
 * Fails closed: fewer than 20 five-minute bars blocks the entry.
 *
 * Pure: the caller passes 1-minute bars (oldest first, last one the current
 * price) and the instrument's tick size.
 */
import { ema } from "../analytics/emaTrend.js";
import { aggregateBars } from "../analytics/intradayEmaProximity.js";
import type { OhlcBar } from "../regime/indicators.js";

export const EMA_PROXIMITY_MAX_TICKS = 15;
/**
 * Per-symbol overrides of EMA_PROXIMITY_MAX_TICKS. NQ 15 -> 45 ticks
 * (2026-11-11, operator request "change NQ MA distance from 15 to 45 ticks").
 * Context: NQ moves several times more ticks than ES for the same %, and NQ
 * entries were sitting 13-512 ticks off its MAs that day. Not harness-validated.
 */
export const EMA_PROXIMITY_MAX_TICKS_BY_SYMBOL: Readonly<Record<string, number>> = { NQ: 45 };
export function emaProximityMaxTicksFor(symbol: string): number {
  return EMA_PROXIMITY_MAX_TICKS_BY_SYMBOL[symbol] ?? EMA_PROXIMITY_MAX_TICKS;
}
export const EMA_PROXIMITY_PERIOD = 20;
export const EMA_PROXIMITY_BAR_MINUTES = 5;

export interface EmaProximityCheck {
  allowed: boolean;
  reason: string;
}

export function checkEmaProximity(bars: OhlcBar[], tickSize: number, maxTicks: number = EMA_PROXIMITY_MAX_TICKS): EmaProximityCheck {
  const closes = aggregateBars(bars, EMA_PROXIMITY_BAR_MINUTES).map((b) => b.close);
  if (closes.length < EMA_PROXIMITY_PERIOD) {
    return { allowed: false, reason: `20 MA proximity: only ${closes.length} ${EMA_PROXIMITY_BAR_MINUTES}m bars, need ${EMA_PROXIMITY_PERIOD}` };
  }
  const emaValue = ema(closes, EMA_PROXIMITY_PERIOD).at(-1)!;
  const price = closes.at(-1)!;
  const ticks = Math.abs(price - emaValue) / tickSize;
  const allowed = ticks <= maxTicks + 1e-9; // float slack so exactly the max counts
  return {
    allowed,
    reason: `20 MA proximity: price ${price.toFixed(2)} is ${ticks.toFixed(1)} ticks from the ${EMA_PROXIMITY_BAR_MINUTES}m EMA${EMA_PROXIMITY_PERIOD} ${emaValue.toFixed(2)} (max ${maxTicks})`,
  };
}

/**
 * 2026-11-11 (operator request: "you should be using the 20 ma indicator on
 * top step"): the live gate now judges against the TopstepX chart's own
 * 20 MA (browserControl/chartMovingAverage.ts) instead of checkEmaProximity's
 * EMA20 from bars_1m, which went stale over a 2026-11-09 -> 2026-11-11 data
 * gap. Same EMA_PROXIMITY_MAX_TICKS limit. Fails closed when the chart bar
 * is older than CHART_MA_MAX_AGE_MS (chart frozen or disconnected).
 * checkEmaProximity above is kept for tests and as the computed reference.
 */
export const CHART_MA_MAX_AGE_MS = 15 * 60_000;

export function checkChartMaProximity(
  read: { ma: number; price: number; barTimeSec: number; resolution: string; chartSymbol: string },
  tickSize: number,
  nowMs: number,
  maxTicks: number = EMA_PROXIMITY_MAX_TICKS,
): EmaProximityCheck {
  const label = `TopstepX ${read.chartSymbol} ${read.resolution}m MA20`;
  const ageMs = nowMs - read.barTimeSec * 1000;
  if (ageMs > CHART_MA_MAX_AGE_MS) {
    return { allowed: false, reason: `20 MA proximity: ${label} last bar is ${Math.round(ageMs / 60_000)} min old -- chart not updating` };
  }
  const ticks = Math.abs(read.price - read.ma) / tickSize;
  const allowed = ticks <= maxTicks + 1e-9;
  return {
    allowed,
    reason: `20 MA proximity: price ${read.price.toFixed(2)} is ${ticks.toFixed(1)} ticks from the ${label} ${read.ma.toFixed(2)} (max ${maxTicks})`,
  };
}

/**
 * Multi-timeframe 20 MA rule (2026-11-11, operator request: "can you set it
 * up for all of those time frames", then "when its in range of two or more").
 * An entry is allowed when the current price is within EMA_PROXIMITY_MAX_TICKS
 * of the 20-period MA on at least MULTI_TF_MA_MIN_NEAR of MULTI_TF_MA_MINUTES.
 *
 * Simple MAs on close (the TopstepX chart's "Moving Average" type), computed
 * from 1-minute bars bucketed per timeframe, the last bucket being the
 * still-forming one -- the same way the chart draws it. The caller may
 * override one timeframe with the chart's own read (`chartOverride`). A
 * timeframe without 20 buckets yet counts as "not near". Fails closed when the
 * newest bar is older than CHART_MA_MAX_AGE_MS.
 *
 * Evidence at the time: none tested. On 2026-11-11 10:40 MST, NQ in a strong
 * up-move sat 55 ticks from the 1m MA and 273-1488 ticks from the 5m-1h MAs,
 * i.e. this rule would only pass on a pullback that reaches two of them.
 * The 2 and the 15 ticks are the operator's numbers. Append any retune here.
 */
export const MULTI_TF_MA_MINUTES = [1, 5, 15, 30, 60] as const;
export const MULTI_TF_MA_MIN_NEAR = 2;

export interface TimeframeMa {
  minutes: number;
  ma: number | null;
  source: "chart" | "bars";
}

export function computeTimeframeSmas(bars: OhlcBar[], period: number = EMA_PROXIMITY_PERIOD): TimeframeMa[] {
  return MULTI_TF_MA_MINUTES.map((minutes) => {
    const closes = aggregateBars(bars, minutes).map((b) => b.close);
    if (closes.length < period) return { minutes, ma: null, source: "bars" as const };
    const window = closes.slice(-period);
    return { minutes, ma: window.reduce((a, b) => a + b, 0) / period, source: "bars" as const };
  });
}

/** One timeframe's row, for the dashboard checklist (2026-11-11). */
export interface TimeframeMaRow {
  label: string;
  minutes: number;
  ma: number | null;
  ticks: number | null;
  near: boolean;
  source: "chart" | "bars";
}

export interface MultiTimeframeMaCheck extends EmaProximityCheck {
  price: number | null;
  nearCount: number;
  minNear: number;
  maxTicks: number;
  rows: TimeframeMaRow[];
}

export function checkMultiTimeframeMaProximity(
  bars: OhlcBar[],
  tickSize: number,
  nowMs: number,
  chartOverride?: { minutes: number; ma: number } | null,
  maxTicks: number = EMA_PROXIMITY_MAX_TICKS,
  minNear: number = MULTI_TF_MA_MIN_NEAR,
): MultiTimeframeMaCheck {
  const empty = { price: null, nearCount: 0, minNear, maxTicks, rows: [] as TimeframeMaRow[] };
  const last = bars.at(-1);
  if (!last) return { allowed: false, reason: "20 MA proximity: no bars", ...empty };
  const ageMs = nowMs - last.time.getTime();
  if (ageMs > CHART_MA_MAX_AGE_MS) {
    return { allowed: false, reason: `20 MA proximity: newest bar is ${Math.round(ageMs / 60_000)} min old -- price feed not updating`, ...empty };
  }
  const price = last.close;
  const mas = computeTimeframeSmas(bars).map((t) =>
    chartOverride && chartOverride.minutes === t.minutes ? { minutes: t.minutes, ma: chartOverride.ma, source: "chart" as const } : t,
  );
  const parts: string[] = [];
  const rows: TimeframeMaRow[] = [];
  let near = 0;
  for (const t of mas) {
    const tf = t.minutes === 60 ? "1h" : `${t.minutes}m`;
    const label = `${tf}${t.source === "chart" ? " (TopstepX chart)" : ""}`;
    if (t.ma === null) {
      parts.push(`${label} n/a`);
      rows.push({ label: tf, minutes: t.minutes, ma: null, ticks: null, near: false, source: t.source });
      continue;
    }
    const ticks = Math.abs(price - t.ma) / tickSize;
    const isNear = ticks <= maxTicks + 1e-9;
    if (isNear) near++;
    parts.push(`${label} ${t.ma.toFixed(2)} ${ticks.toFixed(0)}t${isNear ? " ✓" : ""}`);
    rows.push({ label: tf, minutes: t.minutes, ma: t.ma, ticks, near: isNear, source: t.source });
  }
  const allowed = near >= minNear;
  return {
    allowed,
    reason: `20 MA proximity: price ${price.toFixed(2)} within ${maxTicks} ticks of ${near}/${mas.length} MAs (needs ${minNear}) -- ${parts.join(", ")}`,
    price, nearCount: near, minNear, maxTicks, rows,
  };
}
