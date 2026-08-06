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
