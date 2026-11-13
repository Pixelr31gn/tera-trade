/**
 * Places a stop or take-profit the way the operator does it by hand: press on
 * the open position's P&L tag on the TopstepX chart and drag to the price
 * (2026-11-13, operator: "we also need to set an actual tp and sl ... i need
 * you to emulate that", then "were going to do what i said if it doesnt work
 * then we can fall back to something else").
 *
 * Recorded live 2026-11-13 from the operator's own drags on a 1-lot MES long
 * at 7538: press on the position tag, drag DOWN, release -> TopstepX creates
 * a Stop Market (API type 4) at the release price; drag UP -> a Limit (type 1).
 * No dialog, ~1s per drag, release price snapped to the nearest tick. The two
 * orders are NOT linked (no parent/linked order id) -- the same two separate
 * resting orders the order-ticket path makes, just placed without the ticket.
 *
 * How the tag is found: TopstepX draws the position line, its tag and the
 * order lines with its own code on the chart's main canvas, not as
 * TradingView line objects, so there is nothing to query. The price -> pixel
 * row comes from the chart's own price scale (TradingView API, exact); the
 * tag's left edge is found by scanning that canvas row for a solid colored
 * run (the tag box), right of the order tags.
 *
 * Every refusal happens BEFORE the mouse goes down, and the caller falls back
 * to the order ticket. After the mouse goes up, the result is read back from
 * TopstepX's API: if any new order appeared, the caller must NOT fall back or
 * retry (that is how 7 stops stacked on 2026-11-12).
 */
import { Decimal } from "decimal.js";
import type { Frame, Page } from "playwright-core";
import { childLogger } from "../core/logger.js";
import { chartSymbolToInstrument } from "./chartZones.js";
import { readApiOpenOrders, readApiOpenPosition, type ApiOpenOrder } from "./topstepApi.js";

const logger = childLogger("chartDrag");

/** Release must land at least this far (px) from the position line, so the tags don't overlap. */
const MIN_DRAG_PX = 14;
/** Keep the release this far (px) inside the chart pane. */
const PANE_EDGE_MARGIN_PX = 8;
/** Press this far right of the tag's left edge (the operator pressed ~8px in). */
const TAG_PRESS_OFFSET_PX = 8;
/** A tag is a solid run at least this wide; the position LINE itself is skipped by scanning a few px off it. */
const MIN_TAG_WIDTH_PX = 30;
const MAX_TAG_WIDTH_PX = 200;
/** Accept the created order this many ticks from the asked price (one pixel is ~1.5 MES ticks at a normal zoom). */
export const CHART_DRAG_PRICE_TOLERANCE_TICKS = 2;
const READBACK_ATTEMPTS = 8;
const READBACK_DELAY_MS = 400;

export interface ChartDragRequest {
  symbol: string;
  contractPrefix: string;
  side: "long" | "short";
  kind: "stop" | "limit";
  price: Decimal;
  tickSize: Decimal;
  /** Work out the drag and report it, but press nothing (for supervised testing). */
  planOnly?: boolean;
}

export type ChartDragResult =
  /** Nothing was pressed -- safe to fall back to the order ticket. */
  | { outcome: "not_attempted"; reason: string }
  /** The drag ran and no order appeared or moved -- safe to fall back. */
  | { outcome: "no_order"; reason: string }
  /**
   * An order appeared, or an existing one moved (`moved`). `matches` false = wrong
   * type/side/price; do NOT retry or fall back. Moves: found live 2026-11-13 -- with a stop
   * already on the position, dragging the position tag down MOVED that stop (same order id,
   * 7517.25 -> 7539.50) instead of adding a second; dragging up moved the target the same way
   * (7589.50 -> 7574.25). The position has one stop and one target as far as the drag goes.
   */
  | { outcome: "order_created"; order: ApiOpenOrder; price: number; matches: boolean; moved: boolean; reason: string };

// Source-text form (tsx's __name helper doesn't exist in the page), like chartZones.ts.
const LOCATE_SCRIPT = `((entry, target) => {
  const api = window.tradingViewApi;
  if (!api || api.chartsCount() < 1) return { error: "TradingView chart API not available" };
  const chart = api.chart(0);
  const model = chart._chartWidget.model().model();
  const pane = model.panes()[0];
  const ps = pane.defaultPriceScale();
  const fv = model.mainSeries().firstValue();
  const canvas = Array.from(document.querySelectorAll("canvas")).find((c) => c.parentElement && /chart-gui-wrapper/.test(c.parentElement.className));
  if (!canvas) return { error: "chart canvas not found" };
  const r = canvas.getBoundingClientRect();
  const yEntry = ps.priceToCoordinate(entry, fv);
  const yTarget = ps.priceToCoordinate(target, fv);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { error: "chart canvas unreadable" };
  const sx = canvas.width / r.width;
  // Scan just off the line (the line itself is a full-width run) for the tag box.
  const tags = [];
  for (const dy of [3, 4, -3, -4]) {
    const ly = Math.round((yEntry + dy) * sx);
    if (ly < 0 || ly >= canvas.height) continue;
    const d = ctx.getImageData(0, ly, canvas.width, 1).data;
    let s = -1;
    for (let i = 0; i <= canvas.width; i++) {
      const sat = i < canvas.width && d[i * 4 + 3] > 200 && Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) > 60;
      if (sat && s < 0) s = i;
      if (!sat && s >= 0) { tags.push([s / sx, (i - s) / sx]); s = -1; }
    }
  }
  return { chartSymbol: chart.symbol(), paneX: r.x, paneY: r.y, paneW: r.width, paneH: r.height, yEntry, yTarget, runs: tags };
})`;

interface LocateResult {
  error?: string;
  chartSymbol: string;
  paneX: number;
  paneY: number;
  paneW: number;
  paneH: number;
  yEntry: number;
  yTarget: number;
  runs: Array<[number, number]>;
}

/** Pure: pick the position tag's left edge (pane px) from the scanned runs -- the rightmost tag-sized run. */
export function pickPositionTagX(runs: Array<[number, number]>, paneWidth: number): number | null {
  const tags = runs.filter(([x, w]) => w >= MIN_TAG_WIDTH_PX && w <= MAX_TAG_WIDTH_PX && x > paneWidth * 0.4);
  if (tags.length === 0) return null;
  return Math.max(...tags.map(([x]) => x));
}

/** Pure: the order a drag should create, and whether `o` is it. */
export function isExpectedDragOrder(o: ApiOpenOrder, req: Pick<ChartDragRequest, "side" | "kind" | "price" | "tickSize">): { matches: boolean; price: number | null } {
  const wantType = req.kind === "stop" ? 4 : 1;
  const wantSide = req.side === "long" ? 1 : 0; // closing side: sell under/over a long, buy for a short
  const price = req.kind === "stop" ? o.stopPrice : o.limitPrice;
  if (o.type !== wantType || o.side !== wantSide || price === null) return { matches: false, price };
  const ticksOff = new Decimal(price).minus(req.price).abs().dividedBy(req.tickSize);
  return { matches: ticksOff.lte(CHART_DRAG_PRICE_TOLERANCE_TICKS), price };
}

function chartFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => f.name().startsWith("tradingview_"));
}

export async function dragProtectiveOrderOnChart(page: Page, req: ChartDragRequest): Promise<ChartDragResult> {
  const frame = chartFrame(page);
  if (!frame) return { outcome: "not_attempted", reason: "no TradingView chart on the page" };
  const frameBox = await (await frame.frameElement()).boundingBox();
  if (!frameBox) return { outcome: "not_attempted", reason: "chart frame not visible" };

  const position = await readApiOpenPosition(page, req.contractPrefix);
  if (position === null || position === "flat") return { outcome: "not_attempted", reason: `position unreadable or flat (${String(position)})` };
  if (position.side !== req.side) return { outcome: "not_attempted", reason: `position is ${position.side}, not ${req.side}` };

  const loc = (await frame.evaluate(`${LOCATE_SCRIPT}(${position.averagePrice}, ${req.price.toNumber()})`)) as LocateResult;
  if (loc.error) return { outcome: "not_attempted", reason: loc.error };
  if (chartSymbolToInstrument(loc.chartSymbol) !== req.symbol) {
    return { outcome: "not_attempted", reason: `chart shows ${loc.chartSymbol}, not ${req.symbol}` };
  }
  if (loc.yEntry < PANE_EDGE_MARGIN_PX || loc.yEntry > loc.paneH - PANE_EDGE_MARGIN_PX) {
    return { outcome: "not_attempted", reason: `position line at ${position.averagePrice} is off the visible chart` };
  }
  if (loc.yTarget < PANE_EDGE_MARGIN_PX || loc.yTarget > loc.paneH - PANE_EDGE_MARGIN_PX) {
    return { outcome: "not_attempted", reason: `${req.price.toString()} is off the visible chart` };
  }
  if (Math.abs(loc.yTarget - loc.yEntry) < MIN_DRAG_PX) {
    return { outcome: "not_attempted", reason: `${req.price.toString()} is too close to the position line to drag to (${Math.abs(loc.yTarget - loc.yEntry).toFixed(1)}px)` };
  }
  const tagX = pickPositionTagX(loc.runs, loc.paneW);
  if (tagX === null) return { outcome: "not_attempted", reason: "position tag not found on the chart" };

  const before = await readApiOpenOrders(page, req.contractPrefix);
  if (before === null) return { outcome: "not_attempted", reason: "open orders unreadable before the drag" };
  const beforeById = new Map(before.map((o) => [o.id, o]));

  const x = frameBox.x + loc.paneX + tagX + TAG_PRESS_OFFSET_PX;
  const yFrom = frameBox.y + loc.paneY + loc.yEntry;
  const yTo = frameBox.y + loc.paneY + loc.yTarget;
  if (req.planOnly) {
    return { outcome: "not_attempted", reason: `plan: press (${x.toFixed(0)}, ${yFrom.toFixed(0)}) on the ${position.averagePrice} position tag, drag to y ${yTo.toFixed(0)} = ${req.price.toString()}, release -> ${req.kind === "stop" ? "Stop Market" : "Limit"}; ${before.length} order(s) resting now` };
  }
  logger.info({ symbol: req.symbol, kind: req.kind, price: req.price.toString(), entry: position.averagePrice, x, yFrom, yTo }, "chart_drag_start");

  try {
    await page.mouse.move(x, yFrom);
    await page.mouse.down();
    await page.mouse.move(x, yFrom + Math.sign(yTo - yFrom) * 2, { steps: 2 });
    await page.mouse.move(x, yTo, { steps: 15 });
    await page.mouse.up();
  } catch (err) {
    // Make sure the button isn't left held down; then let the read-back decide.
    await page.mouse.up().catch(() => undefined);
    logger.warn({ symbol: req.symbol, err: String(err) }, "chart_drag_mouse_error");
  }

  for (let i = 0; i < READBACK_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, READBACK_DELAY_MS));
    const after = await readApiOpenOrders(page, req.contractPrefix);
    if (after === null) continue;
    const created = after.filter((o) => !beforeById.has(o.id));
    const moved = after.filter((o) => {
      const was = beforeById.get(o.id);
      return was !== undefined && (was.stopPrice !== o.stopPrice || was.limitPrice !== o.limitPrice);
    });
    const changed = [...created, ...moved];
    if (changed.length === 0) continue;
    const order = changed[0]!;
    const isMove = created.length === 0;
    const { matches, price } = isExpectedDragOrder(order, req);
    const reason = `drag ${isMove ? "moved" : "created"} order ${order.id} (type ${order.type}, side ${order.side}, size ${order.size}, price ${String(price)})${changed.length > 1 ? ` plus ${changed.length - 1} more change(s)` : ""}`;
    if (matches && changed.length === 1) logger.info({ symbol: req.symbol, orderId: order.id, price, moved: isMove }, "chart_drag_order_placed");
    else logger.error({ symbol: req.symbol, created, moved, asked: req.price.toString(), kind: req.kind }, "chart_drag_unexpected_order");
    return { outcome: "order_created", order, price: price ?? NaN, matches: matches && changed.length === 1, moved: isMove, reason };
  }
  return { outcome: "no_order", reason: "drag finished but TopstepX shows no new or moved order" };
}
