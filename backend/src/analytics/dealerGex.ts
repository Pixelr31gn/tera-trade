/**
 * Dealer gamma exposure (GEX) level detection from a raw CBOE index-options
 * chain -- the standard, publicly-documented methodology (see e.g.
 * perfiliev.com's "How to Calculate Gamma Exposure and Zero Gamma Level"),
 * not a reverse-engineered copy of any paid vendor's proprietary numbers.
 *
 * Two open-source reference projects were read before writing this
 * (2026-08-11, operator request, "use your brain to determine what's best"):
 * Matteo-Ferrara/gex-tracker and VandersonTorres/gamma-exposure-indicator.
 * Matteo-Ferrara's CBOE JSON endpoint and GEX-per-contract formula are
 * adopted almost verbatim (confirmed live: that endpoint returns
 * per-contract gamma/open_interest directly -- no Black-Scholes
 * recomputation needed, and current_price for SPX/NDX landed right in the
 * ES/NQ price range at the same moment). VandersonTorres's broader
 * vocabulary (call wall / put wall / gamma flip) is closer to what a real
 * GEX report actually talks about, but that repo's own gamma-flip
 * calculation is an unimplemented TODO stub as of the commit reviewed --
 * findGammaFlip below is a fresh implementation, not a port.
 *
 * Kept pure per CLAUDE.md -- no fetch, no Date.now(), no prisma. The actual
 * CBOE HTTP call and persistence live in marketData/dealerGex.ts.
 */
import type { OhlcBar } from "../regime/indicators.js";

export interface RawCboeOption {
  symbol: string; // OCC-style, e.g. "SPX260821C00200000"
  openInterest: number;
  gamma: number;
}

export interface ParsedOption {
  type: "call" | "put";
  strike: number;
  expiration: Date;
}

/**
 * Which expiration window a computed level came from -- "blended" is the
 * original 0-7-day-inclusive computation (unchanged, feeds the live risk
 * gate); "0dte"/"structural" are the split of that same window used only by
 * the narrative report (2026-08-11, operator request: report the 0DTE book
 * separately from the broader structural one, since they can genuinely
 * diverge -- see marketData/dealerGex.ts's computeDealerLevelsBucketed).
 */
export type DealerGexBucket = "blended" | "0dte" | "structural";

function isSameUtcDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

export interface BucketedOptions<T> {
  zeroDte: T[];
  structural: T[];
}

/**
 * Splits an already-near-dated-filtered option list (see
 * marketData/dealerGex.ts's MAX_EXPIRATION_DAYS_OUT cutoff, applied by the
 * caller before this runs -- same "filtering is a policy choice, not a math
 * one" reasoning as computeGexByStrike above) into same-day (0DTE) vs.
 * everything else in that window (structural). Pure partition, no expiration
 * math beyond a same-UTC-calendar-day check against `at`.
 */
export function bucketOptionsByExpiration<T extends { parsed: ParsedOption }>(options: T[], at: Date): BucketedOptions<T> {
  const zeroDte: T[] = [];
  const structural: T[] = [];
  for (const o of options) {
    (isSameUtcDate(o.parsed.expiration, at) ? zeroDte : structural).push(o);
  }
  return { zeroDte, structural };
}

// OCC option symbol: <root><YYMMDD><C|P><strike*1000, 8 digits zero-padded>.
// Root is variable-length (SPX, SPXW, NDX, NDXP, ...) and not fixed-width,
// so this anchors off the fixed-width date+type+strike suffix instead of
// trying to isolate the root by length.
const OCC_SUFFIX = /(\d{6})([CP])(\d{8})$/;

export function parseOccOptionSymbol(symbol: string): ParsedOption | null {
  const match = OCC_SUFFIX.exec(symbol);
  if (!match) return null;
  const dateStr = match[1]!;
  const typeChar = match[2]!;
  const strikeStr = match[3]!;
  const year = 2000 + Number(dateStr.slice(0, 2));
  const month = Number(dateStr.slice(2, 4));
  const day = Number(dateStr.slice(4, 6));
  const expiration = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(expiration.getTime())) return null;
  const strike = Number(strikeStr) / 1000;
  return { type: typeChar === "C" ? "call" : "put", strike, expiration };
}

const CONTRACT_SIZE = 100;

/**
 * Notional dealer GEX per contract, standard convention: dealers are long
 * calls (positive gamma) and short puts (negative gamma) -- same assumption
 * Matteo-Ferrara/gex-tracker and every public GEX explainer use.
 * GEX = spot * gamma * openInterest * contractSize * spot * 0.01 (the extra
 * spot*0.01 converts to "dollars of delta hedge per 1% move," the standard
 * normalization).
 */
export function computeContractGex(option: RawCboeOption, parsed: ParsedOption, spotPrice: number): number {
  const gex = spotPrice * option.gamma * option.openInterest * CONTRACT_SIZE * spotPrice * 0.01;
  return parsed.type === "put" ? -gex : gex;
}

export interface StrikeGex {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
}

/**
 * Aggregates every option's notional GEX by strike, ascending. Expiration
 * filtering (e.g. "only 0DTE + next N days") happens by the caller before
 * this runs -- what counts as "near-dated" is a policy choice, not a math
 * one, and doesn't belong in a pure aggregation function.
 */
export function computeGexByStrike(options: { raw: RawCboeOption; parsed: ParsedOption }[], spotPrice: number): StrikeGex[] {
  const byStrike = new Map<number, { call: number; put: number }>();
  for (const { raw, parsed } of options) {
    const gex = computeContractGex(raw, parsed, spotPrice);
    const entry = byStrike.get(parsed.strike) ?? { call: 0, put: 0 };
    if (parsed.type === "call") entry.call += gex;
    else entry.put += gex;
    byStrike.set(parsed.strike, entry);
  }
  return [...byStrike.entries()]
    .map(([strike, { call, put }]) => ({ strike, callGex: call, putGex: put, netGex: call + put }))
    .sort((a, b) => a.strike - b.strike);
}

export interface GammaWalls {
  /** Strike with the largest positive net GEX -- a magnet/ceiling, dealers sell into a rally toward it. Null when no strike has positive net GEX. */
  callWall: number | null;
  /** Strike with the largest-magnitude negative net GEX -- a magnet/floor, dealers buy into a decline toward it. Null when no strike has negative net GEX. */
  putWall: number | null;
}

export function findGammaWalls(byStrike: StrikeGex[]): GammaWalls {
  if (byStrike.length === 0) return { callWall: null, putWall: null };
  let callWall = byStrike[0]!;
  let putWall = byStrike[0]!;
  for (const s of byStrike) {
    if (s.netGex > callWall.netGex) callWall = s;
    if (s.netGex < putWall.netGex) putWall = s;
  }
  return {
    callWall: callWall.netGex > 0 ? callWall.strike : null,
    putWall: putWall.netGex < 0 ? putWall.strike : null,
  };
}

/**
 * Gamma flip / zero-gamma level: the price where CUMULATIVE net dealer GEX
 * (strikes summed low-to-high) crosses zero, linearly interpolated between
 * the two straddling strikes for an actual price rather than just "the
 * nearest strike" -- the standard method. Below this level dealers are
 * short gamma (they amplify moves, hedging by selling into declines/buying
 * into rallies); above it they're long gamma (they dampen moves). Returns
 * null when the chain's cumulative GEX never crosses zero.
 *
 * A real chain's cumulative GEX can cross zero more than once (choppy,
 * thinly-traded strikes at the edges of the considered expiration window) --
 * confirmed live (2026-08-11): scanning from the lowest strike and
 * returning the FIRST crossing gave 27,675 for NQ against a same-moment
 * put wall of 29,200 (an exact match to an independent report's floor) and
 * spot at 29,656 -- a crossing 2,000 points from spot is not "the" gamma
 * flip a trader means by that term. Fixed to return whichever crossing is
 * CLOSEST to spot price, since "zero gamma level" describes the regime
 * boundary nearest where price actually is, not an arbitrary distant one.
 */
export function findGammaFlip(byStrike: StrikeGex[], spotPrice: number): number | null {
  if (byStrike.length < 2) return null;
  const crossings: number[] = [];
  let prevStrike = byStrike[0]!.strike;
  let prevTotal = byStrike[0]!.netGex;
  for (let i = 1; i < byStrike.length; i++) {
    const s = byStrike[i]!;
    const newTotal = prevTotal + s.netGex;
    if ((prevTotal <= 0 && newTotal > 0) || (prevTotal >= 0 && newTotal < 0)) {
      const span = newTotal - prevTotal;
      const t = span === 0 ? 0.5 : (0 - prevTotal) / span;
      crossings.push(prevStrike + t * (s.strike - prevStrike));
    }
    prevStrike = s.strike;
    prevTotal = newTotal;
  }
  if (crossings.length === 0) return null;
  return crossings.reduce((closest, c) => (Math.abs(c - spotPrice) < Math.abs(closest - spotPrice) ? c : closest));
}

/**
 * Outcome tracking for a wall/gamma-flip level, walked forward against the
 * bars that actually followed (engine/dealerLevelOutcomeEvaluator.ts) --
 * this is what eventually lets a narrative report say something backed by
 * real history ("this shape of ceiling holds N% of the time") instead of an
 * invented percentage (2026-08-11, operator request: build real historical
 * scenario odds before generating any report that implies them).
 */
export type WallOutcome = "not_reached" | "rejected" | "broken";

/**
 * "Touched" = price's high (call wall) or low (put wall) reached the level
 * at any point in the lookforward window. "Broken" = the window's closing
 * price ended up through it (sustained acceptance); "rejected" = touched but
 * the window closed back on the origin side (held). Never touched at all is
 * its own outcome, not lumped into "rejected" -- a level price never came
 * near says nothing about whether it would have held.
 */
export function computeWallOutcome(wallPrice: number, wallKind: "call_wall" | "put_wall", bars: OhlcBar[]): WallOutcome {
  if (bars.length === 0) return "not_reached";
  const isCallWall = wallKind === "call_wall";
  const touched = bars.some((b) => (isCallWall ? b.high >= wallPrice : b.low <= wallPrice));
  if (!touched) return "not_reached";
  const lastClose = bars[bars.length - 1]!.close;
  const broke = isCallWall ? lastClose > wallPrice : lastClose < wallPrice;
  return broke ? "broken" : "rejected";
}

export type GammaFlipOutcome = "stayed_above" | "stayed_below" | "crossed_up" | "crossed_down";

/** Where price started the window relative to the flip vs. where it ended -- "crossed" means it ended on the opposite side, regardless of intermediate wiggles. */
export function computeGammaFlipOutcome(flipPrice: number, spotAtComputation: number, bars: OhlcBar[]): GammaFlipOutcome {
  const startedAbove = spotAtComputation >= flipPrice;
  const lastClose = bars.length > 0 ? bars[bars.length - 1]!.close : spotAtComputation;
  const endedAbove = lastClose >= flipPrice;
  if (startedAbove === endedAbove) return startedAbove ? "stayed_above" : "stayed_below";
  return startedAbove ? "crossed_down" : "crossed_up";
}
