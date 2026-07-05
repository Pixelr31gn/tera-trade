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

export function extractAccountSnapshot(pageText: string): BrowserAccountSnapshot {
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
export function extractPriceForSymbol(pageText: string, symbol: string, aliases: string[] = []): number | null {
  const lines = pageText.split("\n").map((l) => l.trim()).filter(Boolean);

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
