/**
 * Daily-plan zones computed straight from market data (2026-10-12, operator:
 * "setting daily plan zones has been throwing an error -- fix it").
 *
 * The local model (qwen3:8b) could not reliably turn the context digest into
 * two valid zones: 73 of 212 set_daily_plan_zones calls in two days were
 * rejected, and many accepted ones were unusable anyway (a 430-point "support"
 * zone, touching or overlapping zones -- which risk/engine.ts's
 * evaluateDailyPlanRange treats as no plan -- or levels hundreds of points
 * from the market). The plan is now built here, the same way it was set by
 * hand on 2026-10-07, and is valid by construction:
 *
 *   range      = low / high of the trailing RANGE_LOOKBACK_MS of 1-minute bars
 *                (this session and the previous one; always contains price)
 *   zones      = support at the low, resistance at the high, each one
 *                5-minute ATR wide (ZONE_HALF_WIDTH_ATR5 either side)
 *   likelyMove = the range width, but never under MIN_LIKELY_MOVE_ATR5 x ATR5
 *                -- the session take-profit cap is a third of it, and it must
 *                stay above the minimum target (3 x ATR5, risk/stops.ts) or
 *                every trade is skipped for lack of room.
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import { fiveMinuteAtrPoints } from "../risk/stops.js";
import { getInstrument } from "../marketData/instruments.js";
import { loadRecentBars } from "../engine/bootstrap.js";
import { setDailyPlanZones, type DailyPlanZoneInput } from "../engine/dailyPlanZoneCache.js";
import { setDailyPlanTakeProfitTarget } from "../engine/dailyPlanTakeProfitCache.js";
import { childLogger } from "../core/logger.js";
import { recordAssistantAction, type AuditOutcome } from "./tools.js";

const logger = childLogger("rangePlan");

export const RANGE_LOOKBACK_MS = 24 * 60 * 60_000;
export const ZONE_HALF_WIDTH_ATR5 = 0.5;
export const MIN_LIKELY_MOVE_ATR5 = 9;
/** Bars further than this fraction from the latest close are feed junk (e.g. 0, 375, 2508.40 readings), not prices. */
const JUNK_PRICE_FRACTION = 0.2;

export interface RangePlan {
  price: number;
  low: number;
  high: number;
  atr5: number;
  zones: [DailyPlanZoneInput, DailyPlanZoneInput];
  likelyMovePoints: number;
}

/** Pure: the plan for one symbol from its recent 1-minute bars (oldest first), or a reason it can't be built. */
export function computeRangePlan(bars: OhlcBar[], tickSize: Decimal, nowMs: number): RangePlan | { error: string } {
  const last = bars.at(-1);
  if (!last) return { error: "no bars" };
  const price = last.close;
  const valid = bars.filter((b) => b.low > 0 && Math.abs(b.close - price) <= price * JUNK_PRICE_FRACTION && Math.abs(b.low - price) <= price * JUNK_PRICE_FRACTION && Math.abs(b.high - price) <= price * JUNK_PRICE_FRACTION);
  const window = valid.filter((b) => b.time.getTime() >= nowMs - RANGE_LOOKBACK_MS);
  if (window.length < 30) return { error: `only ${window.length} usable bars in the last 24h` };
  const atr5Dec = fiveMinuteAtrPoints(valid.slice(-300));
  if (!atr5Dec) return { error: "not enough bars for a 5-minute ATR" };
  const atr5 = atr5Dec.toNumber();
  const tick = tickSize.toNumber();
  const low = Math.min(...window.map((b) => b.low));
  const high = Math.max(...window.map((b) => b.high));
  const band = Math.max(2 * tick, Math.round((atr5 * ZONE_HALF_WIDTH_ATR5) / tick) * tick);
  const decimals = tickSize.decimalPlaces();
  const round = (x: number) => Number((Math.round(x / tick) * tick).toFixed(decimals));
  const support: DailyPlanZoneInput = { priceLow: round(low - band), priceHigh: round(low + band), enforcement: "hard", label: `support boundary (24h low ${low})` };
  const resistance: DailyPlanZoneInput = { priceLow: round(high - band), priceHigh: round(high + band), enforcement: "hard", label: `resistance boundary (24h high ${high})` };
  if (!(support.priceHigh < resistance.priceLow)) {
    return { error: `24h range ${low}-${high} is too narrow for two separate zones (each ${(2 * band).toFixed(2)} wide)` };
  }
  if (!(support.priceLow < price && resistance.priceHigh > price)) {
    return { error: `zones ${support.priceLow}-${resistance.priceHigh} don't bracket price ${price}` };
  }
  const likelyMovePoints = Math.round(Math.max(high - low, MIN_LIKELY_MOVE_ATR5 * atr5) * 100) / 100;
  return { price, low, high, atr5, zones: [support, resistance], likelyMovePoints };
}

export interface RangePlanResult {
  planned: Array<{ symbol: string; plan: RangePlan }>;
  skipped: Array<{ symbol: string; error: string }>;
}

/** Computes and saves every symbol's plan for the session `at` falls within. A symbol that can't be built keeps whatever plan it had. */
export async function writeRangePlans(symbols: string[], at: Date): Promise<RangePlanResult> {
  const result: RangePlanResult = { planned: [], skipped: [] };
  for (const symbol of symbols) {
    try {
      const bars = await loadRecentBars(symbol, 1800);
      const plan = computeRangePlan(bars, getInstrument(symbol).tickSize, Date.now());
      if ("error" in plan) {
        result.skipped.push({ symbol, error: plan.error });
        await audit({ symbol, zones: null }, { ok: false, error: `range plan not built for ${symbol}: ${plan.error} (previous zones kept)` });
        continue;
      }
      await setDailyPlanZones(symbol, plan.zones, at);
      await setDailyPlanTakeProfitTarget(symbol, plan.likelyMovePoints, `24h range ${plan.low}-${plan.high} (min ${MIN_LIKELY_MOVE_ATR5}x 5-min ATR)`, at);
      result.planned.push({ symbol, plan });
      await audit(
        { symbol, zones: plan.zones, source: "24h range" },
        { ok: true, summary: `Set 2 daily plan zone(s) for ${symbol} from the 24h range: support ${plan.zones[0].priceLow}-${plan.zones[0].priceHigh}, resistance ${plan.zones[1].priceLow}-${plan.zones[1].priceHigh} (price ${plan.price}).` }
      );
    } catch (err) {
      result.skipped.push({ symbol, error: String(err) });
    }
  }
  logger.info({ planned: result.planned.map((p) => p.symbol), skipped: result.skipped }, "range_plan_written");
  return result;
}

/**
 * Records the write in the assistant-actions audit log under the same tool
 * name the model used, so the dashboard's actions list shows each hourly
 * plan's real result instead of the last model-written attempt (2026-10-13:
 * a day-old set_daily_plan_zones error kept showing there after the fix).
 * An audit failure never blocks the plan itself.
 */
async function audit(input: unknown, outcome: AuditOutcome): Promise<void> {
  await recordAssistantAction("set_daily_plan_zones", input, outcome, null).catch((err) => logger.warn({ err: String(err) }, "range_plan_audit_failed"));
}

/** One-line-per-symbol summary for the chat reply / log. */
export function describeRangePlans(result: RangePlanResult): string {
  const lines = result.planned.map(({ symbol, plan }) =>
    `${symbol} (price ${plan.price}): support ${plan.zones[0].priceLow}-${plan.zones[0].priceHigh}, resistance ${plan.zones[1].priceLow}-${plan.zones[1].priceHigh}, likely move ${plan.likelyMovePoints} pts`
  );
  for (const s of result.skipped) lines.push(`${s.symbol}: not updated -- ${s.error}`);
  return `Daily plan set from the last 24h range:\n${lines.join("\n")}`;
}
