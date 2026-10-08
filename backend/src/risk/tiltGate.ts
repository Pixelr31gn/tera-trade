/**
 * TopstepX "Tilt" direction gate.
 *
 * History (all 2026-10-06, operator requests): first "only trade the side the
 * Tilt favors at >= 51%" on the top row (% Long / % Short), then switched to
 * the bottom row (% Positive / % Negative), then -- "the top and bottom
 * numbers both matter" -- the rule below, which reads them TOGETHER.
 *
 * The two rows (RealTimeTilt, see browserWatch/orderFlowListener.ts):
 *   top    % Long / % Short        -- which way the Topstep crowd is positioned
 *   bottom % Positive / % Negative -- what share of those traders are in profit
 *
 * "Trade with the winning side":
 *   crowd long  + mostly positive -> longs are winning     -> LONG
 *   crowd long  + mostly negative -> longs are trapped     -> SHORT
 *   crowd short + mostly positive -> shorts are winning    -> SHORT
 *   crowd short + mostly negative -> shorts are trapped    -> LONG
 * Neutral zone (operator: "the tilt gate is too tight", same day): the gate
 * only BLOCKS when the Tilt clearly favors the other side -- both rows at
 * TILT_BLOCK_PCT (55%) or more. Anything weaker is treated as undecided and
 * blocks neither side (it still nudges the score, scoring/tiltAdjustment.ts).
 * Before this, a 51.3% / 52.7% reading vetoed ~70% v7 setups as if it were a
 * firm signal.
 *
 * Fails closed: no Tilt reading, or one older than TILT_MAX_AGE_MS, blocks
 * the entry -- otherwise a dead feed would silently turn the rule off.
 *
 * Pure: the caller passes the snapshot and the current time.
 */
import type { OrderFlowSnapshot } from "../browserWatch/orderFlowListener.js";

/** A row counts as leaning one way at this share or more (used for the read/description). */
export const TILT_MIN_ALIGNED_PCT = 51;
/** Both rows must lean at least this far before the gate will block the other side. */
export const TILT_BLOCK_PCT = 55;
export const TILT_MAX_AGE_MS = 2 * 60_000;

export interface TiltReading {
  longPct: number;
  shortPct: number;
  positivePct: number;
  negativePct: number;
}

export interface TiltFavor {
  /** Side the rule favors, or null when either row is too close to call. */
  side: "long" | "short" | null;
  /** Plain-English read, e.g. "longs are winning (62% long, 58% positive)". */
  read: string;
}

/** Both rows of a snapshot, or null when any is missing. */
export function tiltReading(snapshot: OrderFlowSnapshot | null): TiltReading | null {
  const longPct = snapshot?.tiltLongBias ?? null;
  const shortPct = snapshot?.tiltShortBias ?? null;
  const positivePct = snapshot?.tiltPositivePct ?? null;
  const negativePct = snapshot?.tiltNegativePct ?? null;
  if (longPct === null || shortPct === null || positivePct === null || negativePct === null) return null;
  return { longPct, shortPct, positivePct, negativePct };
}

export function tiltFavoredSide(r: TiltReading, minPct: number = TILT_MIN_ALIGNED_PCT): TiltFavor {
  const rows = `${r.longPct.toFixed(1)}% long / ${r.shortPct.toFixed(1)}% short, ${r.positivePct.toFixed(1)}% positive / ${r.negativePct.toFixed(1)}% negative`;
  const crowd = r.longPct >= minPct ? "long" : r.shortPct >= minPct ? "short" : null;
  const winning = r.positivePct >= minPct ? true : r.negativePct >= minPct ? false : null;
  if (crowd === null) return { side: null, read: `crowd positioning is too even to call (${rows})` };
  if (winning === null) return { side: null, read: `winners vs losers is too even to call (${rows})` };
  const crowdLabel = crowd === "long" ? "longs" : "shorts";
  if (winning) return { side: crowd, read: `${crowdLabel} are winning (${rows})` };
  return { side: crowd === "long" ? "short" : "long", read: `${crowdLabel} are trapped (${rows})` };
}

export interface TiltCheck {
  allowed: boolean;
  /** The side the Tilt favors, when a fresh reading exists. */
  favoredSide: "long" | "short" | null;
  reason: string;
}

export function checkTiltAlignment(
  snapshot: OrderFlowSnapshot | null,
  side: "long" | "short",
  nowMs: number
): TiltCheck {
  const reading = tiltReading(snapshot);
  const updatedAt = snapshot?.tiltUpdatedAtMs ?? null;
  if (reading === null || updatedAt === null) {
    return { allowed: false, favoredSide: null, reason: "no TopstepX Tilt reading for this symbol" };
  }
  const ageMs = nowMs - updatedAt;
  if (ageMs > TILT_MAX_AGE_MS) {
    return { allowed: false, favoredSide: null, reason: `TopstepX Tilt reading is stale (${Math.round(ageMs / 1000)}s old)` };
  }
  const favor = tiltFavoredSide(reading, TILT_BLOCK_PCT);
  if (favor.side === null) {
    return { allowed: true, favoredSide: null, reason: `Tilt: not a clear lean (both rows need ${TILT_BLOCK_PCT}%+ to block) -- ${favor.read}` };
  }
  if (favor.side === side) {
    return { allowed: true, favoredSide: favor.side, reason: `Tilt: ${favor.read} -- favors ${side}` };
  }
  return { allowed: false, favoredSide: favor.side, reason: `Tilt: ${favor.read} -- favors ${favor.side}, not ${side}` };
}
