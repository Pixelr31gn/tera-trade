# Browser Watch: reading TopstepX without an API key

Until you have a ProjectX Gateway API key, Tera Trade can read your account balance/P&L and
instrument prices directly off the TopstepX web platform running in your own Chrome, instead
of (or alongside) the free Yahoo Finance price feed. This is **read-only** -- it reads visible
page text over the Chrome DevTools Protocol (CDP); nothing in this path can click, type, place
an order, or change anything on the page.

## How it works

1. You launch Chrome yourself with a debugging port open and log into TopstepX normally.
2. Tera Trade's backend attaches to that already-open tab via CDP (`playwright-core`,
   `connectOverCDP` -- no browser is downloaded or launched by Tera Trade).
3. On an interval (`BROWSER_POLL_SECONDS`, default 5s) it reads the page's visible text and
   looks for account balance/equity/P&L and instrument prices near known labels ("Balance",
   "Net Liquidation", "Open P&L", the instrument symbol).
4. Account snapshots feed `computeAccountEquity` (see `src/engine/accounting.ts`); price ticks
   feed the engine the same way a live bar would (as a single-price bar: open=high=low=close).

## One-time setup

1. Close all existing Chrome windows (the debugging flag only takes effect on a fresh launch;
   with Chrome already running it'll ignore the flag).
2. Launch Chrome with a dedicated debug profile so it doesn't collide with your normal
   session:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug-profile"
   ```
3. Log into TopstepX in that window as usual and navigate to the page showing your account
   balance and the instrument(s) you care about.
4. In `.env`, set:
   ```
   PRICE_SOURCE=browser      # or leave as "yahoo" to keep using free market data for prices
   ACCOUNT_SOURCE=browser    # so the dashboard shows your real balance/P&L, not the simulated $50k
   BROWSER_CDP_URL=http://localhost:9222
   BROWSER_URL_MATCH=topstepx.com
   ```
5. Start (or restart) the backend. It'll log `browser_watch_enabled` and start polling the tab.

## Calibration -- the heuristic will likely need tuning

The default extraction (`src/browserWatch/extract.ts`) is a *label search*, not exact
selectors -- it looks for a line containing "Balance"/"Net Liquidation"/"Open P&L" (or the
instrument symbol) and grabs the nearest dollar-looking number. I can't see your actual
TopstepX page, so this almost certainly needs one round of adjustment together:

1. Run it and check the logs / dashboard. If the balance/price look wrong or are missing,
   open Chrome DevTools on the TopstepX tab, right-click the element showing the correct
   number, choose "Inspect", then right-click the highlighted HTML and "Copy > Copy selector".
2. Share that selector (and which field it's for) and I'll add it to a calibration file, or
   add it yourself at the path pointed to by `BROWSER_SELECTORS_PATH` in this shape:
   ```json
   {
     "balanceSelector": "css selector for the balance element",
     "equitySelector": "css selector for net liquidation / equity",
     "pnlSelector": "css selector for open/day P&L",
     "priceSelectors": { "ES": "css selector for ES's last price", "NQ": "..." }
   }
   ```
   Any field you provide overrides the label-search heuristic for that field; anything left
   out still falls back to the heuristic.

## Limitations

- If TopstepX changes its page layout, extraction can silently start returning wrong or null
  values -- there's no ground truth to validate against automatically. Check the dashboard
  periodically against what the platform actually shows.
- This reads one tab's visible text; if TopstepX renders account data behind a tab/panel
  that isn't currently open in the browser, it won't be captured.
- This is unrelated to a browser *scraping ToS* concern for other sites, but you're reading
  your own account data from your own logged-in session -- reasonable for personal use, but
  worth being aware this isn't an officially supported integration path the way the ProjectX
  Gateway API is.
- Order execution is out of scope for this path entirely -- Tera Trade never uses browser
  automation to place trades, only to observe. Execution still only ever happens through the
  `BrokerClient` interface (`SimulatedBroker` or `ProjectXGatewayBroker`), gated by
  `TRADING_MODE` as always.
