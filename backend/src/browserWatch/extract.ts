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
  /** Map of Terra Trade symbol (e.g. "ES") -> CSS selector for that instrument's last price. */
  priceSelectors?: Record<string, string>;
}

export interface BrowserAccountSnapshot {
  balance: number | null;
  equity: number | null;
  pnl: number | null;
}

const BALANCE_LABELS = ["account balance", "cash balance", "balance"];
const EQUITY_LABELS = ["net liquidation", "account equity", "equity"];
const PNL_LABELS = ["net p&l", "open p&l", "unrealized p&l", "day p&l", "total p&l", "p&l"];

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
  return {
    balance: extractLabeledNumber(pageText, BALANCE_LABELS),
    equity: extractLabeledNumber(pageText, EQUITY_LABELS),
    pnl: extractLabeledNumber(pageText, PNL_LABELS),
  };
}

/** Looks for the given instrument symbol (or a common alias) followed by a plausible price nearby. */
export function extractPriceForSymbol(pageText: string, symbol: string, aliases: string[] = []): number | null {
  const labels = [symbol, ...aliases].map((s) => s.toLowerCase());
  const lines = pageText.split("\n").map((l) => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i]!.toLowerCase();
    if (!labels.some((label) => lineLower.includes(label))) continue;

    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      const match = lines[j]!.match(/-?[\d,]+\.\d{1,4}/); // prices, not integers (avoids matching contract codes/quantities)
      if (match) {
        const value = parseMoney(match[0]);
        if (value !== null) return value;
      }
    }
  }
  return null;
}
