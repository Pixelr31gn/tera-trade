/**
 * Retrospectively labels every computed dealer-GEX snapshot with what
 * actually happened -- same shape as engine/outcomeEvaluator.ts's score
 * labeling, applied to dealer_gex_levels instead of scores. This is what
 * eventually lets a narrative report cite a real historical hold rate
 * ("this ceiling shape has held N of M times") instead of an invented
 * percentage (2026-08-11, operator request: build real historical scenario
 * odds before generating any report that implies them).
 *
 * A snapshot's lookforward window is the rest of the session it was
 * computed in (analytics/session.ts's getSessionEnd) -- matching how these
 * levels are actually talked about ("did the floor hold into the close").
 * Left pending (outcomeEvaluatedAt stays null) until that window has
 * actually closed; there is no meaningful "still open" outcome to report
 * early.
 */
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { getSessionEnd } from "../analytics/session.js";
import { computeWallOutcome, computeGammaFlipOutcome } from "../analytics/dealerGex.js";
import type { OhlcBar } from "../regime/indicators.js";

const logger = childLogger("dealerLevelOutcomeEvaluator");

// Same bounded-per-pass shape as engine/outcomeEvaluator.ts's MAX_ROWS_PER_PASS
// -- a big backlog (e.g. after extended downtime) drains over subsequent
// ticks instead of one tick doing unbounded work.
const MAX_ROWS_PER_PASS = 200;

async function loadBarsBetween(symbol: string, from: Date, to: Date): Promise<OhlcBar[]> {
  const rows = await prisma.bar.findMany({
    where: { symbol, time: { gt: from, lte: to } },
    orderBy: { time: "asc" },
  });
  return rows.map((r) => ({
    time: r.time,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

export async function evaluateDealerLevelOutcomes(): Promise<{ evaluated: number; stillPending: number }> {
  const now = new Date();
  const pending = await prisma.dealerGexLevel.findMany({
    where: { outcomeEvaluatedAt: null },
    orderBy: { time: "asc" },
    take: MAX_ROWS_PER_PASS,
  });

  let evaluated = 0;
  let stillPending = 0;

  for (const row of pending) {
    const windowEnd = getSessionEnd(row.time);
    if (now < windowEnd) {
      stillPending++;
      continue; // this snapshot's session hasn't finished yet -- too soon to judge
    }

    const bars = await loadBarsBetween(row.symbol, row.time, windowEnd);
    if (bars.length === 0) {
      // No bar coverage for this window at all (yet, or ever -- e.g. a gap in
      // the price feed). Leave pending rather than guess; a later pass with
      // real coverage will resolve it.
      stillPending++;
      continue;
    }

    const spotPrice = Number(row.spotPrice.toString());
    const callWallOutcome = row.callWall ? computeWallOutcome(Number(row.callWall.toString()), "call_wall", bars) : null;
    const putWallOutcome = row.putWall ? computeWallOutcome(Number(row.putWall.toString()), "put_wall", bars) : null;
    const gammaFlipOutcome = row.gammaFlip ? computeGammaFlipOutcome(Number(row.gammaFlip.toString()), spotPrice, bars) : null;

    await prisma.dealerGexLevel.update({
      where: { id: row.id },
      data: { callWallOutcome, putWallOutcome, gammaFlipOutcome, outcomeEvaluatedAt: now },
    });
    evaluated++;
  }

  if (evaluated > 0) logger.info({ evaluated, stillPending }, "dealer_level_outcomes_evaluated");
  return { evaluated, stillPending };
}
