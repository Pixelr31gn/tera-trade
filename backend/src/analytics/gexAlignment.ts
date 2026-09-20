/**
 * Regime classification for the GEX shadow log (engine/shadowGexSignalLogger.ts) --
 * 2026-08-28, built off the gamma-desk research brief's recommendation to log
 * observationally before touching any live gate again (the last dealer-GEX
 * proximity gate was removed 2026-08-12 for vetoing good setups). Deliberately
 * does NOT classify whether a trade "aligns" with the regime -- that judgment
 * call belongs to whoever analyzes the accumulated shadow_gex_signals rows
 * later, with real outcome data in hand, not to a hand-picked rule baked in
 * before a single live sample exists. Same "no invented numbers" posture as
 * analytics/dealerLevelReport.ts's scenario section.
 *
 * Kept pure per CLAUDE.md -- no fetch, no Date.now(), no prisma.
 */

export type GexRegime = "positive_gamma" | "negative_gamma" | "unknown";

/**
 * Positive gamma (price at/above the flip) means dealers are net long gamma
 * and hedging dampens moves; negative gamma means dealers are net short and
 * hedging amplifies them -- see analytics/dealerGex.ts's findGammaFlip for
 * how the flip price itself is computed. "unknown" when no flip could be
 * computed (e.g. the CBOE chain never crossed zero, or GEX data was
 * unavailable this tick).
 */
export function classifyGexRegime(spotPrice: number, gammaFlip: number | null): GexRegime {
  if (gammaFlip === null) return "unknown";
  return spotPrice >= gammaFlip ? "positive_gamma" : "negative_gamma";
}
