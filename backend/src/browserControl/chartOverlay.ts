/**
 * Draws the 20 MA checklist as a small box over the TopstepX chart
 * (2026-11-11, operator request: "can we make those a little pop up that
 * shows on the topstepx chart too"). Same numbers as the dashboard's
 * MaProximityPanel -- both come from engine/maProximity.ts, the function the
 * entry gate itself uses.
 *
 * Why it can't disturb anything else on the page:
 *  - It lives inside the TradingView chart iframe, not the main TopstepX
 *    document. Price and account extraction read the main document's
 *    `document.body.innerText` (browserWatch/cdpClient.ts), which never
 *    includes iframe content -- so the overlay's numbers can't be scraped as
 *    a price (the 2026-07-28 incidents were exactly a stray panel's numbers
 *    being read as one).
 *  - Its content sits in a shadow root, and the host has
 *    `pointer-events: none`, so it never takes a click meant for the chart.
 *    The order ticket is in the main document and isn't touched at all.
 *  - It only adds/updates its own element (id OVERLAY_ID). It never draws on
 *    the chart, changes a study, or edits a TradingView drawing.
 * If the chart iframe reloads, the next refresh just recreates the box.
 */
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { connectToChrome, findPage } from "../browserWatch/cdpClient.js";
import type { MultiTimeframeMaCheck } from "../risk/emaProximityGate.js";

const logger = childLogger("chartOverlay");

export const CHART_OVERLAY_REFRESH_MS = 10_000;
const OVERLAY_ID = "tera-trade-ma-overlay";

export interface OverlaySymbol {
  symbol: string;
  allowed: boolean;
  nearCount: number;
  minNear: number;
  maxTicks: number;
  rows: Array<{ label: string; ticks: number | null; near: boolean; source: "chart" | "bars" }>;
}

export function toOverlaySymbols(checks: Array<{ symbol: string } & MultiTimeframeMaCheck>): OverlaySymbol[] {
  return checks.map((c) => ({
    symbol: c.symbol, allowed: c.allowed, nearCount: c.nearCount, minNear: c.minNear, maxTicks: c.maxTicks,
    rows: c.rows.map((r) => ({ label: r.label, ticks: r.ticks === null ? null : Math.round(r.ticks), near: r.near, source: r.source })),
  }));
}

// Source-text form (tsx's __name helper doesn't exist in the page). Builds
// the DOM with textContent only -- no innerHTML.
const RENDER_SCRIPT = `((data) => {
  let host = document.getElementById("${OVERLAY_ID}");
  if (!host) {
    host = document.createElement("div");
    host.id = "${OVERLAY_ID}";
    host.attachShadow({ mode: "open" });
    document.body.appendChild(host);
  }
  // Re-applied every render, so a restyle reaches a box already on the page.
  host.style.cssText = "position:fixed;bottom:64px;left:8px;z-index:2147483000;pointer-events:none;";
  const root = host.shadowRoot;
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };
  const panel = el("div", "font:11px/1.35 ui-monospace,Consolas,monospace;color:#cbd5e1;background:rgba(15,23,42,0.85);border:1px solid rgba(148,163,184,0.35);border-radius:8px;padding:6px 8px;");
  const box = el("div", "display:flex;gap:12px;");
  for (const s of data.symbols) {
    const col = el("div", "min-width:92px;");
    const color = s.allowed ? "#10b981" : "#94a3b8";
    col.appendChild(el("div", "font-weight:700;color:" + color + ";", s.symbol + " " + s.nearCount + "/" + s.rows.length + (s.allowed ? " GO" : "")));
    if (s.rows.length === 0) col.appendChild(el("div", "color:#f59e0b;", "no data"));
    for (const r of s.rows) {
      const line = el("div", "color:" + (r.near ? "#10b981" : "#64748b") + ";",
        (r.near ? "\\u2713 " : "\\u2717 ") + r.label.padEnd(4) + (r.ticks === null ? "n/a" : String(r.ticks).padStart(5) + "t") + (r.source === "chart" ? " *" : ""));
      col.appendChild(line);
    }
    box.appendChild(col);
  }
  const foot = el("div", "font-size:10px;color:#64748b;margin-top:3px;",
    "20 MA: need " + (data.symbols[0] ? data.symbols[0].minNear + "+ within " + data.symbols.map((s) => s.symbol + " " + s.maxTicks + "t").join("/") : "") + " · * = this chart · " + data.time);
  panel.append(box, foot);
  root.replaceChildren(panel);
  return true;
})`;

let warned = false;

/** Draws/updates the overlay. Never throws -- a failed draw is logged once and retried next refresh. */
export async function renderChartOverlay(symbols: OverlaySymbol[]): Promise<void> {
  try {
    const settings = getSettings();
    const browser = await connectToChrome(settings.browserCdpUrl);
    const page = await findPage(browser, settings.browserUrlMatch);
    const frame = page?.frames().find((f) => f.name().startsWith("tradingview_"));
    if (!frame) throw new Error(page ? "no TradingView chart frame" : "TopstepX tab not found");
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    await frame.evaluate(`${RENDER_SCRIPT}(${JSON.stringify({ symbols, time })})`);
    if (warned) logger.info("chart_overlay_recovered");
    warned = false;
  } catch (err) {
    if (!warned) logger.warn({ error: String(err) }, "chart_overlay_render_failed");
    warned = true;
  }
}
