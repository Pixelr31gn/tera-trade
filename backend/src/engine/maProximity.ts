/**
 * The live 20 MA proximity check for one symbol: the bars, the TopstepX
 * chart override, and risk/emaProximityGate.ts's multi-timeframe rule, in
 * one place. Used by both engine/loop.ts's entry gate and the dashboard's
 * checklist (/api/analytics/ma-proximity, 2026-11-11 operator request: "add
 * that checklist to the dashboard"), so the panel always shows exactly what
 * the gate decides on.
 */
import { readChartMovingAverages } from "../browserControl/chartMovingAverage.js";
import { checkMultiTimeframeMaProximity, CHART_MA_MAX_AGE_MS, emaProximityMaxTicksFor, type MultiTimeframeMaCheck } from "../risk/emaProximityGate.js";
import type { OhlcBar } from "../regime/indicators.js";
import { ACTIVE_INSTRUMENTS } from "../marketData/instruments.js";
import { ALIGNMENT_LOOKBACK_BARS } from "../risk/timeframeAlignmentGate.js";
import { loadRecentBars } from "./bootstrap.js";
import { withFormingBar } from "./formingBar.js";

export async function evaluateMaProximity(symbol: string, bars: OhlcBar[], tickSize: number): Promise<MultiTimeframeMaCheck> {
  const chartRead = await readChartMovingAverages();
  const chartMa = chartRead.ok ? chartRead.bySymbol.get(symbol) : undefined;
  const chartMinutes = chartMa ? Number(chartMa.resolution) : NaN;
  const now = Date.now();
  const chartOverride = chartMa && Number.isFinite(chartMinutes) && now - chartMa.barTimeSec * 1000 <= CHART_MA_MAX_AGE_MS
    ? { minutes: chartMinutes, ma: chartMa.ma }
    : null;
  return checkMultiTimeframeMaProximity(bars, tickSize, now, chartOverride, emaProximityMaxTicksFor(symbol));
}

/** The check for every active symbol at the current price -- for the dashboard and the chart overlay. */
export async function evaluateMaProximityForActiveSymbols(): Promise<Array<{ symbol: string } & MultiTimeframeMaCheck>> {
  // Sequential, so all symbols share one cached chart read.
  const out: Array<{ symbol: string } & MultiTimeframeMaCheck> = [];
  for (const spec of ACTIVE_INSTRUMENTS) {
    const bars = withFormingBar(spec.symbol, await loadRecentBars(spec.symbol, ALIGNMENT_LOOKBACK_BARS));
    out.push({ symbol: spec.symbol, ...(await evaluateMaProximity(spec.symbol, bars, spec.tickSize.toNumber())) });
  }
  return out;
}
