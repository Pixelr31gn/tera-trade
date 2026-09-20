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

// Every caller (the main engine's persistent broker, the manual-trade route,
// the close-position route, ad-hoc diagnostics, etc.) used to open its own
// independent connectOverCDP session -- none of them ever actually close
// their Browser object (BrowserControlBroker.disconnect() only drops its own
// local reference, deliberately, since closing it risks closing the user's
// real Chrome window), so these accumulated indefinitely. 2026-07-21: traced
// a real incident here -- a second simultaneous connectOverCDP call while
// the engine's own connection was already active and in use consistently
// hung for the full 30s timeout (confirmed live, multiple times, including
// the manual-trade endpoint failing this way when testing a symbol switch).
// Caching and reusing one connection per cdpUrl is strictly safer than what
// every caller was already doing.
// Keyed by cdpUrl (not a single slot) since the Tradesea second-broker
// integration connects to a genuinely different CDP endpoint (a separate
// Chrome debug profile/port) concurrently with the existing TopstepX one --
// a single shared slot would have each broker's getPage() continually evict
// and reconnect the other's cached connection every call, which is exactly
// the thrashing/hang risk this cache exists to prevent in the first place
// (see the module header comment above). Same per-URL in-flight-promise
// protection as before, just keyed the same way.
const cachedBrowserByUrl = new Map<string, Browser>();
const connectingPromiseByUrl = new Map<string, Promise<Browser>>();

export async function connectToChrome(cdpUrl: string): Promise<Browser> {
  const cached = cachedBrowserByUrl.get(cdpUrl);
  if (cached && cached.isConnected()) {
    return cached;
  }

  const inFlight = connectingPromiseByUrl.get(cdpUrl);
  if (inFlight) return inFlight;

  logger.info({ cdpUrl }, "opening_new_cdp_connection");
  const connecting = (async () => {
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      cachedBrowserByUrl.set(cdpUrl, browser);
      return browser;
    } finally {
      connectingPromiseByUrl.delete(cdpUrl);
    }
  })();
  connectingPromiseByUrl.set(cdpUrl, connecting);
  return connecting;
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

// 2026-07-27 incident: the user got logged out of TopstepX, leaving a
// "topstepx.com/login" tab open alongside (or instead of) the real trading
// tab. That URL still contains "topstepx.com", so findPage happily returned
// it, and every subsequent "price" extracted from it was really just stray
// numbers off the login page's own text (extractPriceForSymbol has no way to
// know it's reading the wrong page) -- corrupting bars_1m for several
// minutes. Worse, minuteBarAggregator's outlier-confirmation guard assumes a
// bad DOM scrape won't reproduce the same wrong number twice, but a static
// login page reproduces its own text byte-for-byte every poll, so the guard
// actually *confirmed* the garbage as a trusted new price level.
//
// First attempted fix was a URL path check (deny-list of "/login" etc, then
// tightened to require "/trade"). Both were wrong: 2026-07-28 confirmed
// live that TopstepX's app is client-side-routed and never updates the
// visible URL to "/trade" at all when the debug-Chrome auto-launch starts
// at the bare root ("https://topstepx.com/", see chromeLauncher.ts's default
// start URL) -- a fully logged-in, fully live trading session with real
// balance/order-ticket/trade-history content sat at that same bare root URL
// indefinitely, which the "/trade"-required check rejected outright, and
// which the earlier deny-list check would have wrongly accepted (a
// redirect-in-progress root page fed a garbage -1000.25 price the very
// first tick after a restart, since a fresh process has no prior accepted
// price yet to sanity-check a first reading against).
//
// URL path is evidently not a reliable signal for this app at all -- content
// is. `extractAccountSnapshot`'s BALANCE_LABELS (extract.ts) already relies
// on a "bal:" label appearing only once genuinely authenticated and on the
// account/trading dashboard (never present on a login screen); reusing that
// same proven marker here instead of the URL settles which real page this
// is, independent of whatever the address bar happens to say.
// Default marker for TopstepX specifically -- findPage's contentMarker
// param (below) lets a second platform (e.g. Tradesea, whose HUD never
// renders this exact "bal:" string) supply its own.
const AUTHENTICATED_PAGE_CONTENT_MARKER = "bal:";

// 2026-07-28 (later same day): the content check above added a
// page.evaluate() call inside findPage that wasn't there before -- and every
// real caller (BrowserWatcher's poll loop, BrowserControlBroker's order
// placement, orderFlowListener) hits findPage independently, on its own
// timer, with no coordination between them. Two of these landing on the same
// page within the same tick made a live order placement's evaluate() call
// throw (confirmed: consensus reached cleanly on both ES and NQ, immediately
// followed by "no_matching_tab_found" then a rejected real order, even
// though the exact same tab was serving the watcher's price extraction fine
// moments before and after). The original silent `catch { continue }` had no
// way to tell "this really is the wrong page" apart from "this evaluate call
// just got unlucky" -- it treated both as a hard miss. A couple of quick
// retries before giving up on an otherwise-URL-matching candidate covers the
// transient case without weakening the actual login-page rejection (a real
// login page's evaluate() succeeds fine every time; it just lacks the
// marker).
const EVALUATE_RETRIES = 3;
const EVALUATE_RETRY_DELAY_MS = 150;

async function readBodyTextWithRetry(page: Page): Promise<string | null> {
  for (let attempt = 1; attempt <= EVALUATE_RETRIES; attempt++) {
    try {
      return await page.evaluate(() => document.body.innerText);
    } catch (err) {
      if (attempt === EVALUATE_RETRIES) {
        logger.warn({ err: String(err), attempt }, "find_page_evaluate_failed_giving_up");
        return null;
      }
      logger.warn({ err: String(err), attempt }, "find_page_evaluate_failed_retrying");
      await new Promise((resolve) => setTimeout(resolve, EVALUATE_RETRY_DELAY_MS));
    }
  }
  return null;
}

/** Finds the open tab that's on `urlMatch`'s (e.g. "topstepx.com") genuine, authenticated trading dashboard -- not just any tab whose URL happens to contain the domain, which also matches a login screen or a redirect-in-progress page. Distinguishes by page *content* (see contentMarker, default AUTHENTICATED_PAGE_CONTENT_MARKER), not URL path, since a client-side router doesn't reliably reflect page state in the URL. */
export async function findPage(
  browser: Browser,
  urlMatch: string,
  contentMarker: string = AUTHENTICATED_PAGE_CONTENT_MARKER
): Promise<Page | null> {
  let domainSeenButNotAuthenticated = false;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      if (!url.includes(urlMatch)) continue;
      const text = await readBodyTextWithRetry(page);
      if (text === null) continue; // couldn't read this candidate even after retries -- try the next one
      if (!text.toLowerCase().includes(contentMarker.toLowerCase())) {
        domainSeenButNotAuthenticated = true;
        continue;
      }
      ensureDialogHandler(page);
      return page;
    }
  }
  if (domainSeenButNotAuthenticated) {
    logger.warn({ urlMatch }, "matched_tab_not_authenticated");
  } else {
    logger.warn({ urlMatch }, "no_matching_tab_found");
  }
  return null;
}

/** Reads the page's fully-rendered visible text, the same shape a heuristic label search expects. */
export async function readPageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}
