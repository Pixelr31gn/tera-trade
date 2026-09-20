/**
 * Reads Tradesea's "Positions" tab (Open sub-tab) -- a single list of every
 * currently-open real position across every symbol at once, one row per
 * position. Mirrors browserControl/positionsPanel.ts's role for TopstepX,
 * but Tradesea's DOM has no data-testid/data-field attributes at all
 * (confirmed live, 2026-08-26) -- rows are located structurally, anchored
 * off the header row's own column labels ("Time"/"Symbol"/"Size"/"Side"/
 * "Average Price"/"UP&L"/"Actions"), which is what stays stable if styling
 * changes even though there's no dedicated test-id to anchor on directly.
 * Verified live: each row is 7 direct-child cells in that exact column
 * order.
 */
import type { Page } from "playwright-core";
import { childLogger } from "../../core/logger.js";
import { matchesContractPrefix } from "./pure.js";

const logger = childLogger("tradesea/positionsPanel");

const SYMBOL_CELL_INDEX = 1;
const AVERAGE_PRICE_CELL_INDEX = 4;

// "Open" is Positions' own default sub-tab (confirmed live, 2026-08-26:
// styled with the active "border-primary" class before ever being clicked).
// Clicking it unconditionally hit a covering overlay and timed out
// (Playwright's own action log: "intercepts pointer events") -- exactly the
// class of bug findBlockingModalText/no-op-if-already-selected patterns
// elsewhere in this codebase exist to avoid. Only click when NOT already
// selected.
async function ensurePositionsOpenTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Positions", exact: true }).click();
  const openToggle = page.locator('button:has(span:text-is("Open"))');
  const isActive = (await openToggle.getAttribute("class"))?.includes("border-primary") ?? false;
  if (!isActive) await openToggle.click();
}

async function getRows(page: Page) {
  const header = page.locator('span:text-is("Average Price")').locator("xpath=ancestor::div[contains(@class,'grid-cols-8')][1]");
  if ((await header.count()) === 0) return null;
  const rowsContainer = header.locator("xpath=following-sibling::div[1]");
  return rowsContainer.locator(":scope > div.grid");
}

/**
 * Returns the set of contract roots (e.g. "MNQ") with a currently open row,
 * or null if the panel itself couldn't be read -- callers must treat null
 * as "unknown," never as "everything is flat" (same posture as TopstepX's
 * positionsPanel.ts).
 */
export async function getOpenPositionRoots(page: Page): Promise<Set<string> | null> {
  try {
    await ensurePositionsOpenTab(page);
    const rows = await getRows(page);
    if (rows === null) {
      logger.warn("tradesea_positions_panel_not_found");
      return null;
    }
    const count = await rows.count();
    const roots = new Set<string>();
    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator(":scope > *");
      const symbolText = (await cells.nth(SYMBOL_CELL_INDEX).innerText().catch(() => "")).trim();
      if (!symbolText) continue;
      const root = symbolText.split(":").pop()?.trim().toUpperCase();
      if (root) roots.add(root);
    }
    return roots;
  } catch (err) {
    logger.warn({ err: String(err) }, "tradesea_positions_panel_read_failed");
    return null;
  }
}

/** Is `contractPrefix` (e.g. "MNQ") currently flat, per the Positions panel? Returns null (never guess) if the panel itself couldn't be read. */
export async function isPositionFlatViaPanel(page: Page, contractPrefix: string): Promise<boolean | null> {
  const openRoots = await getOpenPositionRoots(page);
  if (openRoots === null) return null;
  return !openRoots.has(contractPrefix.toUpperCase());
}

/**
 * Reads the real fill/average price for `contractPrefix`'s currently-open
 * row, or null if the panel, the row, or the price cell isn't readable --
 * callers must fall back to the theoretical signal price on null. Never throws.
 */
export async function readOpenPositionFillPrice(page: Page, contractPrefix: string): Promise<number | null> {
  try {
    await ensurePositionsOpenTab(page);
    const rows = await getRows(page);
    if (rows === null) {
      logger.warn("tradesea_positions_panel_not_found");
      return null;
    }
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator(":scope > *");
      const symbolText = (await cells.nth(SYMBOL_CELL_INDEX).innerText().catch(() => "")).trim();
      if (!matchesContractPrefix(symbolText, contractPrefix)) continue;
      const priceText = (await cells.nth(AVERAGE_PRICE_CELL_INDEX).innerText().catch(() => "")).trim();
      const parsed = Number(priceText.replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      return null;
    }
    return null;
  } catch (err) {
    logger.warn({ err: String(err), contractPrefix }, "tradesea_positions_panel_fill_price_read_failed");
    return null;
  }
}
