/**
 * Generic label-based text extraction for reading account/price data off a
 * broker web platform's rendered text (e.g. `document.body.innerText`),
 * without needing exact CSS selectors calibrated in advance.
 *
 * This is inherently a heuristic, not a precise parser -- it looks for a
 * known label (e.g. "Balance", "Net P&L") and grabs the nearest
 * dollar-looking number on the same or a following line. It's meant to get
 * something working immediately; `CalibratedSelectors` (below) lets you
 * override with exact selectors once you've inspected the real page and
 * know precisely where each field lives.
 */

export interface CalibratedSelectors {
  /** CSS selector whose text content is the account balance/cash value. */
  balanceSelector?: string;
  /** CSS selector whose text content is the account equity (balance +/- open P&L). */
  equitySelector?: string;
  /** CSS selector whose text content is today's or open P&L. */
  pnlSelector?: string;
  /** Map of Tera Trade symbol (e.g. "ES") -> CSS selector for that instrument's last price. */
  priceSelectors?: Record<string, string>;
}

export interface BrowserAccountSnapshot {
  balance: number | null;
  equity: number | null;
  pnl: number | null;
  /** Display name of the currently-active TopstepX account (e.g. "50K DLL COMBINE"), not unique across combines of the same tier -- see brokerAccountId for the actual identity. */
  accountName: string | null;
  /** Unique real account identifier (e.g. "50KTC-V2-DLL-170199-51281387"), confirmed live 2026-07-21 -- this, not accountName, is what distinguishes one real TopstepX account from another. */
  brokerAccountId: string | null;
}

// "bal:"/"up&l:" are TopstepX's own compact HUD notation (confirmed against
// a real account page); "bal"/"up&l" (no colon) are Tradesea's own -- its
// account panel renders "Bal" and "UP&L" as bare labels on their own line,
// confirmed live 2026-08-28 against the real sandbox account (extraction
// returned all-null before this addition). The longer-form labels are kept
// as a fallback for other broker platforms. No label for Tradesea's "RP&L"
// (realized P&L) -- BrowserAccountSnapshot has no field for it, and nothing
// downstream needs it: equity is already correctly synthesized below from
// balance + unrealized P&L alone.
const BALANCE_LABELS = ["bal:", "bal", "account balance", "cash balance", "balance"];
const EQUITY_LABELS = ["net liquidation", "account equity", "equity"];
const UNREALIZED_PNL_LABELS = ["up&l:", "up&l", "unrealized p&l", "open p&l"];

/** Parses a dollar-like string into a number, handling $, commas, and accounting-style negatives like "($1,234.56)". */
export function parseMoney(raw: string): number | null {
  const trimmed = raw.trim();
  const isParenNegative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$,]/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (Number.isNaN(value)) return null;
  return isParenNegative ? -Math.abs(value) : value;
}

const MONEY_PATTERN = /\(?-?\$?\s?-?[\d,]+(?:\.\d+)?\)?/;

/** Finds the first dollar-looking number in `text`. */
function firstMoneyMatch(text: string): number | null {
  const match = text.match(MONEY_PATTERN);
  if (!match) return null;
  return parseMoney(match[0]);
}

/**
 * Searches `pageText` (typically `innerText`, one visible string per line)
 * for a line containing one of `labels` (case-insensitive), then returns the
 * first dollar-looking number on that line or one of the next two lines.
 */
export function extractLabeledNumber(pageText: string, labels: string[]): number | null {
  const lines = pageText.split("\n").map((l) => l.trim()).filter(Boolean);
  const lowerLabels = labels.map((l) => l.toLowerCase());

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i]!.toLowerCase();
    if (!lowerLabels.some((label) => lineLower.includes(label))) continue;

    const sameLineValue = firstMoneyMatch(lines[i]!.toLowerCase().replace(lowerLabels.find((l) => lineLower.includes(l))!, ""));
    if (sameLineValue !== null) return sameLineValue;

    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const value = firstMoneyMatch(lines[j]!);
      if (value !== null) return value;
    }
  }
  return null;
}

// TopstepX's "Order Filled"/rejected/cancelled toast notifications can
// linger in the DOM far longer than they're visually shown (confirmed live,
// 2026-07-15: a stale toast from an old closed trade sat in the page for
// hours) and contain a contract code + "Execute Price: ..." line that reads
// exactly like a live quote row to the label-based extraction below.
// Without stripping these first, a fallback substring match (e.g. "nq"
// matching inside "MNQU26") can latch onto a frozen historical fill price
// forever instead of the actual current market price -- this was traced to
// a real incident where NQ's price and every downstream signal/analytics
// read (points-per-minute, real strategy signals) went dead for 30+ minutes
// because the extraction got stuck on one old toast's fill price. Each
// toast block is a fixed, short shape (heading, then a "<qty> <contract>
// <order type>" line, then "Execute Price: ..." (or similar), then often
// one trailing %-figure line) -- stripped out entirely before any
// extraction runs, from every toast in the page, not just the first.
const TOAST_HEADING_PATTERN = /^(order filled|order rejected|order cancelled|order canceled|order working)$/i;
const TOAST_BODY_LINES_TO_SKIP = 3;

function stripToastNotifications(pageText: string): string {
  const lines = pageText.split("\n");
  const result: string[] = [];
  let toastLinesRemaining = 0;
  for (const rawLine of lines) {
    if (TOAST_HEADING_PATTERN.test(rawLine.trim())) {
      toastLinesRemaining = TOAST_BODY_LINES_TO_SKIP;
      continue;
    }
    if (toastLinesRemaining > 0) {
      toastLinesRemaining--;
      continue;
    }
    result.push(rawLine);
  }
  return result.join("\n");
}

export interface BrowserAccountIdentity {
  name: string;
  brokerAccountId: string;
}

// TopstepX renders the currently-active account (account switcher button,
// and again inside each order-entry widget) as a single line shaped like
// "<display name>|<account ID>", optionally followed by an eligibility
// status in parens -- confirmed live from two real captures: an older one
// with no status suffix ("$50K TRADING COMBINE|50KTC-V2-170199-40086833")
// and a newer one with one (2026-07-21, "50K DLL COMBINE|50KTC-V2-DLL-
// 170199-51281387 (Ineligible)") -- the status suffix's presence and even
// the ID's own segment count aren't assumed stable. The display name alone
// isn't unique (multiple combines can share a tier name like "50K DLL
// COMBINE"); the ID is what actually distinguishes one real account from
// another, which matters once an operator switches between several funded
// accounts in the same browser -- without tracking this, every account's
// equity history gets blended together under one internal account row
// (2026-07-21 incident). This line appears multiple times on the page for
// the one truly active account, so the first match is sufficient.
const ACCOUNT_IDENTITY_PATTERN = /^(.+?)\|([A-Z0-9]+(?:-[A-Z0-9]+)+?)(?:\s*\([^)]*\))?$/i;

export function extractActiveAccountIdentity(rawPageText: string): BrowserAccountIdentity | null {
  const lines = stripToastNotifications(rawPageText).split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(ACCOUNT_IDENTITY_PATTERN);
    if (match) return { name: match[1]!.trim(), brokerAccountId: match[2]!.trim() };
  }
  return null;
}

export function extractAccountSnapshot(rawPageText: string): BrowserAccountSnapshot {
  const pageText = stripToastNotifications(rawPageText);
  const balance = extractLabeledNumber(pageText, BALANCE_LABELS);
  const explicitEquity = extractLabeledNumber(pageText, EQUITY_LABELS);
  const unrealizedPnl = extractLabeledNumber(pageText, UNREALIZED_PNL_LABELS);

  // Most platforms (TopstepX included) don't show a separate "equity"/"net
  // liquidation" figure at all -- equity is balance plus whatever's still
  // open, so synthesize it when there's no explicit label for it.
  const equity = explicitEquity ?? (balance !== null && unrealizedPnl !== null ? balance + unrealizedPnl : balance);
  const identity = extractActiveAccountIdentity(rawPageText);

  return { balance, equity, pnl: unrealizedPnl, accountName: identity?.name ?? null, brokerAccountId: identity?.brokerAccountId ?? null };
}

// CME futures month codes: one letter per month (F=Jan ... Z=Dec).
const FUTURES_MONTH_CODES = "FGHJKMNQUVXZ";

// 2026-07-27 incident: this used to be a bare substring search
// (`/-?[\d,]+\.\d{1,4}/`, no anchors), which matched a decimal-shaped
// fragment *inside* a longer line, not just a standalone price line -- when
// a closed-trade history table row (containing "MNQU26") sat above the real
// quotes panel, one of its columns was a timestamp like
// "2026-07-27 16:01:00.991", and the substring "00.991" matched the price
// regex, feeding a garbage 0.991 into bars_1m as NQ's price for several
// minutes straight. Every real price line seen on this page (quote tables,
// watchlists) is a standalone line with nothing else on it, so requiring the
// *entire* trimmed line to be just the number rejects any line that merely
// contains a number somewhere inside other text (timestamps, labels, etc.)
// without losing any legitimate match.
function findNearbyPrice(lines: string[], startIndex: number): number | null {
  for (let j = startIndex; j < Math.min(startIndex + 3, lines.length); j++) {
    const match = lines[j]!.match(/^-?\$?[\d,]+\.\d{1,4}$/); // the whole line, not just a substring of it
    if (match) {
      const value = parseMoney(match[0]);
      if (value !== null) return value;
    }
  }
  return null;
}

/**
 * Looks for the given instrument symbol's price nearby in `pageText`.
 *
 * Tries the actual CME contract code first (e.g. "ESU26" for a September
 * 2026 ES contract, as quote tables actually display it) before falling back
 * to a loose substring match on the bare symbol/alias -- the loose match
 * alone is unreliable: e.g. "ES" is a substring of "sal**es**" in a "Time and
 * Sales" heading, which would false-positive-match well before the real
 * quote row and return null without ever reaching it. Unlike a single
 * first-match-wins search, this keeps scanning past any label match that
 * doesn't yield a nearby price instead of giving up.
 */
export function extractPriceForSymbol(rawPageText: string, symbol: string, aliases: string[] = []): number | null {
  const lines = stripToastNotifications(rawPageText).split("\n").map((l) => l.trim()).filter(Boolean);

  // Optional leading "M" recognizes TopstepX's Micro contract codes (e.g.
  // "MNQU26" for Micro NQ) as a genuine, anchored contract-code match instead
  // of falling through to the much less reliable loose substring search
  // below (see the 2026-07-27 incident note on findNearbyPrice).
  const contractCodePattern = new RegExp(`^M?${symbol}[${FUTURES_MONTH_CODES}]\\d{2}$`, "i");
  for (let i = 0; i < lines.length; i++) {
    if (!contractCodePattern.test(lines[i]!)) continue;
    const price = findNearbyPrice(lines, i);
    if (price !== null) return price;
  }

  const labels = [symbol, ...aliases].map((s) => s.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i]!.toLowerCase();
    if (!labels.some((label) => lineLower.includes(label))) continue;
    const price = findNearbyPrice(lines, i);
    if (price !== null) return price;
  }

  return null;
}

// Matches any CME-style contract code (not just the one we're looking for),
// used to detect where the current quote row ends and the next one begins.
const ANY_CONTRACT_CODE_PATTERN = new RegExp(`^[A-Z]{1,3}[${FUTURES_MONTH_CODES}]\\d{2}$`, "i");

/**
 * Looks for the given instrument symbol's traded volume in a quote table row.
 *
 * TopstepX's Quotes panel lists Last/Change/%Chg/Open/Bid/Ask/High/Low/Volume
 * per contract row -- every column except Volume is either a decimal price or
 * has a "%" sign, so within one row's line span, the last plain integer
 * (comma-grouped, no decimal point, no "%") is the volume figure. This is a
 * heuristic over rendered position, not a named label (TopstepX doesn't put
 * "Volume:" next to the number the way it does for account fields), so it
 * only looks within the current row (stops at the next contract code) to
 * avoid drifting into an unrelated column.
 */
export function extractVolumeForSymbol(rawPageText: string, symbol: string, aliases: string[] = []): number | null {
  const lines = stripToastNotifications(rawPageText).split("\n").map((l) => l.trim()).filter(Boolean);
  // Optional leading "M" recognizes TopstepX's Micro contract codes (e.g.
  // "MNQU26" for Micro NQ) as a genuine, anchored contract-code match instead
  // of falling through to the much less reliable loose substring search
  // below (see the 2026-07-27 incident note on findNearbyPrice).
  const contractCodePattern = new RegExp(`^M?${symbol}[${FUTURES_MONTH_CODES}]\\d{2}$`, "i");

  for (let i = 0; i < lines.length; i++) {
    if (!contractCodePattern.test(lines[i]!)) continue;

    let volume: number | null = null;
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      if (ANY_CONTRACT_CODE_PATTERN.test(lines[j]!)) break; // next row started
      if (/^[\d,]+$/.test(lines[j]!)) volume = parseMoney(lines[j]!);
    }
    if (volume !== null) return volume;
  }

  return null;
}

/**
 * TopstepX's Quotes "Volume" column is cumulative session volume, not
 * per-tick volume -- feeding that raw number in as a bar's volume would make
 * it monotonically increase forever and make volume-based scoring features
 * (which expect "how much traded in this period") meaningless. This turns a
 * new cumulative reading into a per-tick delta, given the last cumulative
 * reading seen for that symbol.
 *
 * Returns 0 (rather than a spurious spike) on the first observation or a
 * session rollover (current < previous, e.g. the exchange's daily volume
 * counter reset).
 */
export function computeVolumeDelta(previousCumulative: number | null, currentCumulative: number): number {
  if (previousCumulative === null) return 0;
  if (currentCumulative < previousCumulative) return 0;
  return currentCumulative - previousCumulative;
}
