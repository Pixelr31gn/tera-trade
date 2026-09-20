/**
 * Read-only view of the most recently computed dealer GEX levels per symbol
 * (analytics/dealerGex.ts, marketData/dealerGex.ts) -- the "report" half of
 * the 2026-08-11 operator request ("generate a report for asian/london/new
 * york, find the best levels to trade"). The actual trading restriction is
 * risk/engine.ts's dealer-level proximity gate, wired in separately; this
 * route exists purely so the levels driving that gate are visible somewhere
 * rather than only inferable from the backend log's dealer_gex_computed
 * lines.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../../core/security.js";
import { prisma } from "../../db/client.js";
import { ACTIVE_INSTRUMENTS } from "../../marketData/instruments.js";
import { buildDealerLevelReport } from "../../engine/dealerLevelReportBuilder.js";

/** Shared by GET /api/dealer-levels and the assistant's get_dealer_levels tool. */
export async function getDealerLevelsSnapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const spec of ACTIVE_INSTRUMENTS) {
    // Explicit bucket filter (2026-08-11) -- dealer_gex_levels now also
    // holds report-only "0dte"/"structural" rows (marketData/dealerGex.ts's
    // computeAndPersistDealerLevelsBucketed) alongside the original
    // "blended" ones. Without this filter, "most recent row regardless of
    // bucket" would non-deterministically return whichever bucket's write
    // happened to land last, instead of the one this endpoint has always
    // meant: the same value that feeds risk/engine.ts's live proximity
    // gate.
    const row = await prisma.dealerGexLevel.findFirst({
      where: { symbol: spec.symbol, bucket: "blended" },
      orderBy: { time: "desc" },
    });
    if (!row) continue;
    out[spec.symbol] = {
      time: row.time,
      session: row.session,
      spotPrice: row.spotPrice.toString(),
      callWall: row.callWall?.toString() ?? null,
      putWall: row.putWall?.toString() ?? null,
      gammaFlip: row.gammaFlip?.toString() ?? null,
      callWallConfirmedByPriceAction: row.callWallConfirmed,
      putWallConfirmedByPriceAction: row.putWallConfirmed,
    };
  }
  return out;
}

// The narrative report (2026-08-11, operator request) -- real numbers only,
// no fabricated scenario odds. See analytics/dealerLevelReport.ts's own
// header comment for why. Shared with the assistant's
// get_dealer_levels_report tool.
export async function getDealerLevelsReportSnapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const spec of ACTIVE_INSTRUMENTS) {
    const report = await buildDealerLevelReport(spec.symbol);
    if (report) out[spec.symbol] = report;
  }
  return out;
}

export async function dealerLevelsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/dealer-levels", async () => getDealerLevelsSnapshot());

  app.get("/api/dealer-levels/report", async () => getDealerLevelsReportSnapshot());
}
