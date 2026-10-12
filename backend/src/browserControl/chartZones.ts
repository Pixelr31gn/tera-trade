/**
 * Reads the price rectangles the operator draws on the TopstepX chart
 * (2026-10-06, operator request: "when I place a certain indicator on the
 * chart, trades only execute in that window" -- a rectangle, used as a price
 * zone). risk/chartZoneGate.ts turns these into the entry rule.
 *
 * TopstepX's chart is TradingView's charting library, inside an iframe named
 * "tradingview_*". That iframe exposes the full charting API as
 * `window.tradingViewApi` (the capitalised `TradingViewApi` is a cut-down
 * stub): chart(i).symbol() and chart(i).getAllShapes() /
 * getShapeById(id).getPoints(). Read-only -- nothing here draws, moves or
 * deletes anything.
 *
 * TradingView only exposes the drawings of the symbol a chart is SHOWING, so
 * a symbol is covered only while some chart in the layout displays it.
 */
import type { Page } from "playwright-core";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { DEFAULT_INSTRUMENTS } from "../marketData/instruments.js";
import { connectToChrome, findPage } from "../browserWatch/cdpClient.js";

const logger = childLogger("chartZones");

export interface ChartPriceZone {
  low: number;
  high: number;
  /** Chart symbol it was drawn on, e.g. "MNQZ26". */
  chartSymbol: string;
}

export type ChartZoneRead =
  | { ok: true; zonesBySymbol: Map<string, ChartPriceZone[]>; chartedSymbols: Set<string> }
  | { ok: false; error: string };

// Same source-text form as topstepApi.ts: tsx wraps function-form evaluate
// bodies in a `__name` helper that doesn't exist in the page.
const READ_RECTANGLES_SCRIPT = `(() => {
  const api = window.tradingViewApi;
  if (!api || typeof api.chartsCount !== "function") return { error: "TradingView chart API not available" };
  const charts = [];
  for (let i = 0; i < api.chartsCount(); i++) {
    const c = api.chart(i);
    const rects = [];
    for (const s of c.getAllShapes()) {
      if (s.name !== "rectangle") continue;
      const shape = c.getShapeById(s.id);
      const pts = shape.getPoints() || [];
      if (pts.length < 2) continue;
      let props = {};
      try { props = shape.getProperties() || {}; } catch (e) {}
      rects.push([pts[0].price, pts[1].price, Math.min(pts[0].time, pts[1].time), Math.max(pts[0].time, pts[1].time), !!props.extendLeft, !!props.extendRight]);
    }
    charts.push({ symbol: c.symbol(), rects });
  }
  return { charts };
})()`;

const ROOT_TO_SYMBOL: Record<string, string> = {
  ...Object.fromEntries(DEFAULT_INSTRUMENTS.map((i) => [i.symbol, i.symbol])),
  ...Object.fromEntries(DEFAULT_INSTRUMENTS.map((i) => [i.brokerContractPrefix, i.symbol])),
};

/** "MNQZ26" / "NQZ26" / "MNQ1!" -> "NQ"; null if not a tracked instrument. */
export function chartSymbolToInstrument(chartSymbol: string): string | null {
  const bare = chartSymbol.toUpperCase().replace(/^.*:/, "").replace(/\d*!$/, "");
  const match = bare.match(/^([A-Z]+?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  const root = match ? match[1]! : bare;
  return ROOT_TO_SYMBOL[root] ?? null;
}

/** Is a rectangle spanning [fromSec, toSec] (chart time, epoch seconds) active at `nowSec`? */
export function isRectangleActive(fromSec: number, toSec: number, extendLeft: boolean, extendRight: boolean, nowSec: number): boolean {
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) return false;
  return (extendLeft || nowSec >= fromSec) && (extendRight || nowSec <= toSec);
}

async function readFromPage(page: Page, nowMs: number): Promise<ChartZoneRead> {
  const frame = page.frames().find((f) => f.name().startsWith("tradingview_"));
  if (!frame) return { ok: false, error: "no TradingView chart found on the TopstepX page" };
  const raw = (await frame.evaluate(READ_RECTANGLES_SCRIPT)) as {
    error?: string;
    charts?: Array<{ symbol: string; rects: Array<[number, number, number, number, boolean, boolean]> }>;
  };
  if (raw.error || !raw.charts) return { ok: false, error: raw.error ?? "chart read returned nothing" };
  const nowSec = nowMs / 1000;
  const zonesBySymbol = new Map<string, ChartPriceZone[]>();
  const chartedSymbols = new Set<string>();
  for (const chart of raw.charts) {
    const symbol = chartSymbolToInstrument(chart.symbol);
    if (!symbol) continue;
    chartedSymbols.add(symbol);
    const zones = zonesBySymbol.get(symbol) ?? [];
    for (const [a, b, fromSec, toSec, extendLeft, extendRight] of chart.rects) {
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      // Only a box that covers NOW counts (2026-10-11, operator choice): a
      // box from an earlier day sat off-screen to the left and still let
      // trades through when price came back to its level. Extend left/right
      // keeps a box open in that direction.
      if (!isRectangleActive(fromSec, toSec, extendLeft, extendRight, nowSec)) continue;
      zones.push({ low: Math.min(a, b), high: Math.max(a, b), chartSymbol: chart.symbol });
    }
    zonesBySymbol.set(symbol, zones);
  }
  return { ok: true, zonesBySymbol, chartedSymbols };
}

const CACHE_MS = 3_000;
let cache: { at: number; read: ChartZoneRead } | null = null;

/** Current rectangles per instrument, read live from the TopstepX chart (cached for a few seconds). */
export async function readChartPriceZones(): Promise<ChartZoneRead> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.read;
  let read: ChartZoneRead;
  try {
    const settings = getSettings();
    const browser = await connectToChrome(settings.browserCdpUrl);
    const page = await findPage(browser, settings.browserUrlMatch);
    read = page ? await readFromPage(page, Date.now()) : { ok: false, error: "TopstepX tab not found" };
  } catch (err) {
    read = { ok: false, error: String(err) };
  }
  if (!read.ok) logger.warn({ error: read.error }, "chart_zone_read_failed");
  cache = { at: Date.now(), read };
  return read;
}
