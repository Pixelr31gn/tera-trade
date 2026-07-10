/// <reference lib="dom" />
/**
 * Attaches to an already-running Chrome instance over the Chrome DevTools
 * Protocol (CDP) -- no browser is launched or downloaded. You start Chrome
 * yourself with `--remote-debugging-port=9222`, log into TopstepX normally in
 * that window, and this just reads the page; nothing here can click, type,
 * or submit anything.
 *
 * See docs/BROWSER_WATCH.md for the one-time Chrome launch step.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { childLogger } from "../core/logger.js";

const logger = childLogger("cdpClient");

export async function connectToChrome(cdpUrl: string): Promise<Browser> {
  return chromium.connectOverCDP(cdpUrl);
}

// Without an explicit application-level dialog listener, Playwright's own
// internal auto-dismiss logic can race a native browser dialog (window.
// confirm/alert/beforeunload -- e.g. an order-confirmation prompt) closing
// through some other path, throwing an unhandled "No dialog is showing"
// protocol error from deep inside Playwright's own event handling -- outside
// any try/catch a caller could write, which crashed the entire backend
// process the one time this happened live. Registering our own handler here
// gives Playwright a definitive, immediate handler instead of relying on its
// race-prone default.
const dialogHandledPages = new WeakSet<Page>();

function ensureDialogHandler(page: Page): void {
  if (dialogHandledPages.has(page)) return;
  dialogHandledPages.add(page);
  page.on("dialog", (dialog) => {
    logger.warn({ type: dialog.type(), message: dialog.message() }, "js_dialog_auto_dismissed");
    dialog.dismiss().catch((err) => logger.warn({ err: String(err) }, "dialog_dismiss_failed"));
  });
}

/** Finds the first open tab whose URL contains `urlMatch` (e.g. "topstepx.com"). */
export async function findPage(browser: Browser, urlMatch: string): Promise<Page | null> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url().includes(urlMatch)) {
        ensureDialogHandler(page);
        return page;
      }
    }
  }
  logger.warn({ urlMatch }, "no_matching_tab_found");
  return null;
}

/** Reads the page's fully-rendered visible text, the same shape a heuristic label search expects. */
export async function readPageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}
