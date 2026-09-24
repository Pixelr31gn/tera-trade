/**
 * Reads TopstepX's dedicated "Positions" panel (a MUI DataGrid the operator
 * added to their layout specifically for this, 2026-07-22) -- a single
 * table listing every currently-open real position across every symbol at
 * once, with one row per open position (confirmed live: `data-testid=
 * "positions-display-table"`, rows carry `data-id` and per-column
 * `data-field` cells -- "symbolName" e.g. "/MES", "positionSize" e.g. "-1").
 *
 * This replaces the order-entry widget's per-symbol isPositionFlat check for
 * managing already-open trades (see engine/loop.ts's manageLiveOpenTrade).
 * That widget is shared by every symbol on this account, so checking one
 * symbol's status could switch it away from another symbol's contract (or,
 * left read-only, silently fail whenever it wasn't already showing the
 * right one) -- confirmed live, twice, as a real cause of missed trailing-
 * stop closes. The Positions panel has no such contention: it's a passive
 * list of every open position at once, read in a single pass, no switching
 * or per-symbol context needed at all.
 */
import type { Page } from "playwright-core";
import { childLogger } from "../core/logger.js";

const logger = childLogger("positionsPanel");

/**
 * Returns the set of contract roots (e.g. "MES", "MNQ") with a currently
 * open row in the Positions panel, or null if the panel itself couldn't be
 * read (the operator removed it from their layout, a DOM change, etc.) --
 * callers must treat null as "unknown," never as "everything is flat."
 */
export async function getOpenPositionRoots(page: Page): Promise<Set<string> | null> {
  const table = page.locator('[data-testid="positions-display-table"]');
  if ((await table.count()) === 0) {
    logger.warn("positions_panel_not_found");
    return null;
  }

  try {
    const rows = table.locator('[role="row"][data-id]');
    const symbolTexts = await rows.locator('[data-field="symbolName"]').allTextContents();
    // "/MES" -> "MES" -- strip TopstepX's leading slash, keep the rest as-is
    // rather than assuming a fixed length, since a contract root can vary
    // (MES/MNQ/MCL/MGC today, potentially others later).
    return new Set(symbolTexts.map((s) => s.trim().replace(/^\//, "").toUpperCase()).filter(Boolean));
  } catch (err) {
    logger.warn({ err: String(err) }, "positions_panel_read_failed");
    return null;
  }
}

/**
 * Is `contractPrefix` (e.g. "MES") currently flat, per the Positions panel?
 * Returns null (never guess) if the panel itself couldn't be read at all.
 */
export async function isPositionFlatViaPanel(page: Page, contractPrefix: string): Promise<boolean | null> {
  const openRoots = await getOpenPositionRoots(page);
  if (openRoots === null) return null;
  return !openRoots.has(contractPrefix.toUpperCase());
}

// Candidate data-field names for the row's entry/fill price cell, tried in
// order (2026-08-17, operator request: the broker previously never read back
// a real fill price at all, always echoing the theoretical signal price
// instead -- see brokers/browserControlBroker.ts's header comment). First
// name is the one the operator confirmed directly against the live DOM
// ("entry price"); the second is a fallback for a row that doesn't expose
// that field under this exact key, following this file's existing
// camelCase data-field convention ("symbolName", "positionSize") since a MUI
// DataGrid's field keys don't always match its visible column labels
// one-to-one.
// 2026-09-24: "averagePrice" added FIRST, and it is the one that actually
// works. Neither prior candidate had ever matched -- every real entry since
// file logging was enabled logged real_fill_price_unavailable with
// lastDeviationPoints: null, meaning no reading was obtained at all, not that a
// reading was rejected. The table and the row were always found (this file's
// own isPositionFlatViaPanel works off the same locators); only the price cell
// lookup fell through, silently, because the loop below just returns null when
// no candidate matches.
//
// Confirmed by dumping the live grid's headers rather than guessing a third
// name: the column labelled "Entry Price" carries data-field="averagePrice".
// The full row is entryTime / symbolName / positionSize / averagePrice / risk.
// "entryPrice" was the visible LABEL, not the field key -- which is exactly the
// mismatch the original comment below anticipated and then guessed wrong about.
//
// Cost of those two months: every trade's stop and target were anchored to the
// theoretical signal price instead of the real fill. Live trade 119 recorded an
// entry of 30546.75 against a real fill of 30732.50 -- 185.75 points out, which
// made its stored risk read as 1.00pt against a genuine 186.75pt stop.
//
// Values carry thousands separators ("30,732.50"); the parse below already
// strips them.
const FILL_PRICE_FIELD_CANDIDATES = ["averagePrice", "entryPrice", "avgPrice"];

/**
 * Reads the real fill/entry price for `contractPrefix`'s currently-open row,
 * or null if the panel, the row, or a usable price cell isn't readable --
 * callers must fall back to the theoretical signal price on null, same
 * "never guess" posture as isPositionFlatViaPanel above. Never throws.
 */
export async function readOpenPositionFillPrice(page: Page, contractPrefix: string): Promise<number | null> {
  const table = page.locator('[data-testid="positions-display-table"]');
  if ((await table.count()) === 0) {
    logger.warn("positions_panel_not_found");
    return null;
  }

  try {
    const rows = table.locator('[role="row"][data-id]');
    const symbolTexts = await rows.locator('[data-field="symbolName"]').allTextContents();
    const rowIndex = symbolTexts.findIndex((s) => s.trim().replace(/^\//, "").toUpperCase() === contractPrefix.toUpperCase());
    if (rowIndex === -1) return null;

    const row = rows.nth(rowIndex);
    for (const field of FILL_PRICE_FIELD_CANDIDATES) {
      const cell = row.locator(`[data-field="${field}"]`);
      if ((await cell.count()) === 0) continue;
      const text = (await cell.first().textContent())?.trim();
      if (!text) continue;
      const parsed = Number(text.replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  } catch (err) {
    logger.warn({ err: String(err), contractPrefix }, "positions_panel_fill_price_read_failed");
    return null;
  }
}
