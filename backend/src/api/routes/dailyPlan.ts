/**
 * Read-only snapshot of today's daily-plan range + take-profit target per
 * symbol, for the dashboard (2026-08-31, operator request: "make sure the
 * trading plan is displayed on the main dashboard" -- replacing the Quick
 * Order panel, which the operator doesn't use). Reuses the exact same
 * session-scoped stores the risk engine gates real trades against
 * (dailyPlanZoneCache.ts, dailyPlanTakeProfitCache.ts) -- this is a display
 * of the real, currently-active gate, not a separate approximation of it.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../../core/security.js";
import { listActiveDailyPlanZones } from "../../engine/dailyPlanZoneCache.js";
import { listActiveDailyPlanTakeProfitTargets } from "../../engine/dailyPlanTakeProfitCache.js";
import { DAILY_PLAN_TAKE_PROFIT_FRACTION } from "../../risk/stops.js";
import { getMarketSnapshot } from "./market.js";

// Matches assistant/dailyPlanScheduler.ts's PLAN_SYMBOLS -- the only symbols
// this whole feature (daily-plan zones + take-profit target) applies to.
const PLAN_SYMBOLS = ["ES", "NQ", "GC"];

export interface DailyPlanSymbolView {
  support: { priceLow: number; priceHigh: number; label: string } | null;
  resistance: { priceLow: number; priceHigh: number; label: string } | null;
  /** The assistant's own undiscounted read of the likely achievable move -- see set_daily_take_profit_target's description. */
  takeProfitLikelyMovePoints: number | null;
  /** DAILY_PLAN_TAKE_PROFIT_FRACTION of the above -- the real cap a fixed-target trade's take-profit is scaled against. */
  takeProfitCapPoints: number | null;
  takeProfitLabel: string | null;
  currentPrice: number | null;
  /**
   * Where currentPrice actually sits relative to the two boundaries right
   * now -- mirrors risk/engine.ts's evaluateDailyPlanRange classification
   * (testing a zone vs. mid-range vs. a confirmed break), for display only;
   * the real gate decision also depends on trade side, which this ignores.
   */
  status: "no_plan" | "below_support" | "testing_support" | "mid_range" | "testing_resistance" | "above_resistance";
}

export async function getDailyPlanSnapshot(): Promise<Record<string, DailyPlanSymbolView>> {
  const now = new Date();
  const [zonesBySymbol, takeProfitBySymbol, marketSnapshot] = await Promise.all([
    listActiveDailyPlanZones(now),
    listActiveDailyPlanTakeProfitTargets(now),
    getMarketSnapshot(),
  ]);
  const marketBySymbol = new Map(marketSnapshot.map((m) => [m.symbol, m]));

  const result: Record<string, DailyPlanSymbolView> = {};
  for (const symbol of PLAN_SYMBOLS) {
    const zones = zonesBySymbol[symbol] ?? [];
    const takeProfit = takeProfitBySymbol[symbol] ?? null;
    const lastPrice = marketBySymbol.get(symbol)?.lastPrice ?? null;
    const currentPrice = lastPrice !== null ? Number(lastPrice.toString()) : null;

    let support: DailyPlanSymbolView["support"] = null;
    let resistance: DailyPlanSymbolView["resistance"] = null;
    if (zones.length === 2) {
      const [a, b] = zones;
      const s = a!.priceLow.lte(b!.priceLow) ? a! : b!;
      const r = s === a ? b! : a!;
      support = { priceLow: s.priceLow.toNumber(), priceHigh: s.priceHigh.toNumber(), label: s.label };
      resistance = { priceLow: r.priceLow.toNumber(), priceHigh: r.priceHigh.toNumber(), label: r.label };
    }

    let status: DailyPlanSymbolView["status"] = "no_plan";
    if (support && resistance && currentPrice !== null) {
      if (currentPrice >= support.priceLow && currentPrice <= support.priceHigh) status = "testing_support";
      else if (currentPrice >= resistance.priceLow && currentPrice <= resistance.priceHigh) status = "testing_resistance";
      else if (currentPrice < support.priceLow) status = "below_support";
      else if (currentPrice > resistance.priceHigh) status = "above_resistance";
      else status = "mid_range";
    }

    result[symbol] = {
      support,
      resistance,
      takeProfitLikelyMovePoints: takeProfit !== null ? takeProfit.likelyMovePoints.toNumber() : null,
      takeProfitCapPoints: takeProfit !== null ? takeProfit.likelyMovePoints.times(DAILY_PLAN_TAKE_PROFIT_FRACTION).toNumber() : null,
      takeProfitLabel: takeProfit?.label ?? null,
      currentPrice,
      status,
    };
  }
  return result;
}

export async function dailyPlanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);
  app.get("/api/daily-plan", async () => getDailyPlanSnapshot());
}
