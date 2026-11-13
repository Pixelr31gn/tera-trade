/**
 * Reads the 20-period Moving Average the operator keeps on the TopstepX chart
 * (2026-11-11, operator request: "you should be using the 20 ma indicator on
 * top step"). risk/emaProximityGate.ts's checkChartMaProximity turns it into
 * the entry rule, replacing the EMA20 computed from bars_1m -- that one went
 * stale after the backend was down 2026-11-09 23:50 UTC -> 2026-11-11 14:16
 * UTC (no bars for the gap), reading ~28,157 against a live ~28,370.
 *
 * Same source as browserControl/chartZones.ts: TradingView's charting
 * library inside the "tradingview_*" iframe, `window.tradingViewApi`. The
 * study's own computed series (`_study.data().last()` -> [time, ma, ...]) is
 * read rather than the legend text, because the legend follows the mouse
 * crosshair. The price compared against it is the chart's own last bar close,
 * so both numbers come from the same chart at the same instant.
 *
 * As found 2026-11-11: one chart, MNQZ26 on 5-minute bars, one "Moving
 * Average" study, length 20, source close (a simple MA, not an EMA).
 * Read-only -- nothing here draws, moves or edits anything.
 */
import type { Page } from "playwright-core";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { connectToChrome, findPage } from "../browserWatch/cdpClient.js";
import { chartSymbolToInstrument } from "./chartZones.js";

const logger = childLogger("chartMovingAverage");

export const CHART_MA_LENGTH = 20;

export interface ChartMovingAverage {
  ma: number;
  /** The chart's last bar close, read at the same moment as `ma`. */
  price: number;
  /** Chart bar time of the MA value, epoch seconds. */
  barTimeSec: number;
  /** Chart resolution, e.g. "5". */
  resolution: string;
  chartSymbol: string;
}

export type ChartMaRead =
  | { ok: true; bySymbol: Map<string, ChartMovingAverage> }
  | { ok: false; error: string };

// Source-text form, like chartZones.ts (tsx's __name helper doesn't exist in the page).
const READ_MA_SCRIPT = `(() => {
  const api = window.tradingViewApi;
  if (!api || typeof api.chartsCount !== "function") return { error: "TradingView chart API not available" };
  const charts = [];
  for (let i = 0; i < api.chartsCount(); i++) {
    const c = api.chart(i);
    let found = null;
    for (const s of c.getAllStudies()) {
      if (s.name !== "Moving Average") continue;
      const st = c.getStudyById(s.id);
      let length = null;
      try { const inp = st.getInputValues().find((v) => v.id === "length"); length = inp ? inp.value : null; } catch (e) {}
      if (length !== ${CHART_MA_LENGTH}) continue;
      let last = null;
      try { const l = st._study.data().last(); last = l ? (l.value || l) : null; } catch (e) {}
      if (last) { found = last; break; }
    }
    let bar = null;
    try { const b = c._chartWidget.model().mainSeries().bars().last(); bar = b ? (b.value || b) : null; } catch (e) {}
    charts.push({ symbol: c.symbol(), resolution: c.resolution(), ma: found, bar });
  }
  return { charts };
})()`;

async function readFromPage(page: Page): Promise<ChartMaRead> {
  const frame = page.frames().find((f) => f.name().startsWith("tradingview_"));
  if (!frame) return { ok: false, error: "no TradingView chart found on the TopstepX page" };
  const raw = (await frame.evaluate(READ_MA_SCRIPT)) as {
    error?: string;
    charts?: Array<{ symbol: string; resolution: string; ma: number[] | null; bar: number[] | null }>;
  };
  if (raw.error || !raw.charts) return { ok: false, error: raw.error ?? "chart read returned nothing" };
  const bySymbol = new Map<string, ChartMovingAverage>();
  for (const chart of raw.charts) {
    const symbol = chartSymbolToInstrument(chart.symbol);
    if (!symbol || bySymbol.has(symbol) || !chart.ma || !chart.bar) continue;
    const [barTimeSec, ma] = chart.ma;
    const price = chart.bar[4];
    if (!Number.isFinite(ma) || !Number.isFinite(price) || !Number.isFinite(barTimeSec)) continue;
    bySymbol.set(symbol, { ma: ma!, price: price!, barTimeSec: barTimeSec!, resolution: chart.resolution, chartSymbol: chart.symbol });
  }
  return { ok: true, bySymbol };
}

const CACHE_MS = 2_000;
let cache: { at: number; read: ChartMaRead } | null = null;

/** The chart's current 20 MA per instrument, read live from TopstepX (cached for a couple of seconds). */
export async function readChartMovingAverages(): Promise<ChartMaRead> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.read;
  let read: ChartMaRead;
  try {
    const settings = getSettings();
    const browser = await connectToChrome(settings.browserCdpUrl);
    const page = await findPage(browser, settings.browserUrlMatch);
    read = page ? await readFromPage(page) : { ok: false, error: "TopstepX tab not found" };
  } catch (err) {
    read = { ok: false, error: String(err) };
  }
  if (!read.ok) logger.warn({ error: read.error }, "chart_ma_read_failed");
  cache = { at: Date.now(), read };
  return read;
}
