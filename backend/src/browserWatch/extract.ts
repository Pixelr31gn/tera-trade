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
}

// "bal:"/"up&l:" etc. are TopstepX's own compact HUD notation (confirmed
// against a real account page); the longer-form labels are kept as a
// fallback for other broker platforms.
const BALANCE_LABELS = ["bal:", "account balance", "cash balance", "balance"];
const EQUITY_LABELS = ["net liquidation", "account equity", "equity"];
const UNREALIZED_PNL_LABELS = ["up&l:", "unrealized p&l", "open p&l"];

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

export function extractAccountSnapshot(rawPageText: string): BrowserAccountSnapshot {
  const pageText = stripToastNotifications(rawPageText);
  const balance = extractLabeledNumber(pageText, BALANCE_LABELS);
  const explicitEquity = extractLabeledNumber(pageText, EQUITY_LABELS);
  const unrealizedPnl = extractLabeledNumber(pageText, UNREALIZED_PNL_LABELS);

  // Most platforms (TopstepX included) don't show a separate "equity"/"net
  // liquidation" figure at all -- equity is balance plus whatever's still
  // open, so synthesize it when there's no explicit label for it.
  const equity = explicitEquity ?? (balance !== null && unrealizedPnl !== null ? balance + unrealizedPnl : balance);

  return { balance, equity, pnl: unrealizedPnl };
}

// CME futures month codes: one letter per month (F=Jan ... Z=Dec).
const FUTURES_MONTH_CODES = "FGHJKMNQUVXZ";

function findNearbyPrice(lines: string[], startIndex: number): number | null {
  for (let j = startIndex; j < Math.min(startIndex + 3, lines.length); j++) {
    const match = lines[j]!.match(/-?[\d,]+\.\d{1,4}/); // prices, not integers (avoids matching contract codes/quantities)
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

  const contractCodePattern = new RegExp(`^${symbol}[${FUTURES_MONTH_CODES}]\\d{2}$`, "i");
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
  const contractCodePattern = new RegExp(`^${symbol}[${FUTURES_MONTH_CODES}]\\d{2}$`, "i");

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
