/**
 * Chart rectangle entry gate (2026-10-06, operator request: trades only
 * execute inside a price zone the operator draws as a rectangle on the
 * TopstepX chart; with no rectangle on the chart, no trades for that symbol).
 *
 * An entry is allowed only while the current price is inside at least one of
 * the symbol's rectangles (top/bottom edges, inclusive). Fails closed: no
 * rectangle, no chart showing the symbol, or a failed chart read all block.
 *
 * Pure: the caller passes the chart read (browserControl/chartZones.ts).
 */
import type { ChartZoneRead } from "../browserControl/chartZones.js";

export interface ChartZoneCheck {
  allowed: boolean;
  reason: string;
}

export function checkChartZone(read: ChartZoneRead, symbol: string, price: number): ChartZoneCheck {
  if (!read.ok) {
    return { allowed: false, reason: `couldn't read the chart rectangles (${read.error})` };
  }
  if (!read.chartedSymbols.has(symbol)) {
    return { allowed: false, reason: `no TopstepX chart is showing ${symbol} -- open one and draw a rectangle to allow ${symbol} trades` };
  }
  const zones = read.zonesBySymbol.get(symbol) ?? [];
  if (zones.length === 0) {
    return { allowed: false, reason: `no rectangle drawn on the ${symbol} chart` };
  }
  const inside = zones.find((z) => price >= z.low && price <= z.high);
  if (inside) {
    return { allowed: true, reason: `price ${price} is inside the chart rectangle ${inside.low.toFixed(2)}-${inside.high.toFixed(2)}` };
  }
  const nearest = zones.reduce((best, z) => {
    const d = price < z.low ? z.low - price : price - z.high;
    return d < best.d ? { z, d } : best;
  }, { z: zones[0]!, d: Number.POSITIVE_INFINITY });
  return {
    allowed: false,
    reason: `price ${price} is outside every ${symbol} chart rectangle (nearest ${nearest.z.low.toFixed(2)}-${nearest.z.high.toFixed(2)}, ${nearest.d.toFixed(2)} pts away)`,
  };
}
