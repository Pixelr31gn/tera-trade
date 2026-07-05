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

/** Finds the first open tab whose URL contains `urlMatch` (e.g. "topstepx.com"). */
export async function findPage(browser: Browser, urlMatch: string): Promise<Page | null> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url().includes(urlMatch)) return page;
    }
  }
  logger.warn({ urlMatch }, "no_matching_tab_found");
  return null;
}

/** Reads the page's fully-rendered visible text, the same shape a heuristic label search expects. */
export async function readPageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}
