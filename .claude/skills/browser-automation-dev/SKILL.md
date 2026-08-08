---
name: browser-automation-dev
description: How to safely write and test new Playwright DOM automation against the live TopstepX page (backend/src/browserControl, browserWatch/cdpClient.ts) without risking the user's real Chrome session or real orders
---

Tera Trade drives TopstepX's real web UI via Playwright's `connectOverCDP`, attached to the
user's own already-open, already-logged-in Chrome (a dedicated debug profile, not their daily
browser -- see `chromeLauncher.ts`). This means every exploratory script you write runs against
the **real, live account**. Follow this process, not ad-hoc trial and error.

## The one rule that matters most: never call `browser.close()`

The `Browser` object from `connectOverCDP` is a **borrowed connection to the user's real Chrome
window**, not a browser you launched. `browser.close()` closes their actual window. Every
diagnostic script must skip cleanup entirely and just let the process exit.

## Writing a read-only diagnostic script

```ts
// backend/_tmp_check_something.ts -- delete when done, never commit
import { connectToChrome, findPage } from "./src/browserWatch/cdpClient.js";
import { getSettings } from "./src/core/config.js";

async function main() {
  const settings = getSettings();
  const browser = await connectToChrome(settings.browserCdpUrl);
  const page = await findPage(browser, settings.browserUrlMatch);
  if (!page) { console.log("NO PAGE FOUND"); process.exit(1); }

  // ... your read-only locator checks ...

  // REQUIRED: the CDP connection keeps Node's event loop alive forever.
  // Without this the script hangs indefinitely even after main() finishes.
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
```

Run it from **inside `backend/`** (not the repo root -- module resolution and the local
`node_modules`/`tsx` both depend on this), with the env file explicit (env vars aren't
auto-loaded outside the normal `npm run dev` invocation):

```bash
cd backend && npx tsx --env-file=.env _tmp_check_something.ts
```

Delete the script when done (`rm backend/_tmp_*.ts`) -- these are scratch, never commit them.

## Connection reuse (as of 2026-07-21)

`cdpClient.ts`'s `connectToChrome` caches one `Browser` connection per `cdpUrl` and reuses it
across every caller in the process -- the main engine's persistent broker, the manual-trade
route, ad-hoc diagnostic scripts, all share it. This means:

- Your diagnostic script, run while the backend is up, will **reuse the backend's own live
  connection** instead of opening a second one -- this is what makes read-only checks fast and
  reliable now. Before this fix, a second simultaneous `connectOverCDP` call while the engine's
  connection was already active reliably hung for the full 30s timeout (confirmed live, multiple
  times) -- if you ever see that exact symptom again, suspect this caching regressed, not Chrome.
- Nothing anywhere calls `Browser.close()` (per the rule above), so a genuinely dead/unresponsive
  Chrome (the CDP endpoint stops responding even to a fresh connection -- happens after long
  uptime) requires actually closing the OS-level Chrome process before a fresh
  `CHROME_AUTO_LAUNCH` can help; see the `verify` skill and `docs/BROWSER_CONTROL.md` for that
  recovery flow. Chrome's own processes ARE visible to `Get-Process`/`Get-CimInstance` from
  PowerShell (multi-process architecture -- expect a dozen-plus `chrome.exe` entries for one
  window; filter by `-like '*chrome-debug-profile*'` or `-like '*remote-debugging-port*'` in the
  command line to confirm they're the dedicated debug profile, not confuse them with a
  once-observed session where none were visible at all -- if that happens again, ask the operator
  to check the window directly rather than trusting an empty process list as "Chrome is closed."

## Finding selectors: prefer `data-testid`, verify live before trusting

MUI's auto-generated IDs (`:r8h:`-style) are **not stable** across renders -- confirmed live.
Always look for a `data-testid` attribute first. When exploring a new interaction:

1. Dump the relevant DOM region's `outerHTML` (a few ancestor levels) to find real `data-testid`s
   and structural roles, rather than guessing from what's visually rendered.
2. Check `getAttribute("role")` on inputs that look like plain text fields -- several are actually
   MUI `Autocomplete` comboboxes (`role="combobox"`) that need click -> type -> select-option, not
   a plain `.fill()`.
3. For a combobox/autocomplete: `click()` the input, `.fill(searchText)`, wait, then
   `page.getByRole("option", { name: /pattern/i }).first().click()` -- and always read the input's
   value back afterward to confirm the selection actually took, not just that the click didn't
   throw.

## Popovers/dialogs: verify state changes, don't assume a click's effect

**Confirmed root cause of two real unprotected-position incidents in one night**: a popover's
button row can change meaning based on form state (e.g. TopstepX's bracket settings popover shows
"Close" when unedited, but "Cancel"/"Save Changes" once anything in it is touched) -- clicking a
button by stale assumption instead of checking what's actually rendered silently does the wrong
thing while every input-level readback still looks "correct" (since those checks only read the
popover's own live state, not whether anything was actually persisted or the dialog actually
closed). After any action meant to persist+dismiss something: verify the *end state* you actually
care about (e.g. `.MuiDialog-root[role="presentation"]` no longer visible), not just that the
click you issued didn't throw.

## Before wiring a new interaction into a live order-placement path

1. Explore and validate read-only first (steps above), against the real page, with the market
   open if the interaction depends on live state (position cards, fills, etc.).
2. Get explicit operator confirmation before the first REAL write action (a real click), even if
   `DRY_RUN_ORDERS=true` -- ask which they want (dry run vs. a real small test) rather than
   assuming.
3. After wiring it in for real, watch the very next live occurrence closely and confirm the
   *actual* resulting state (the trades table, the real account) rather than trusting that no
   error was thrown. "No error" and "did what was intended" are not the same thing here --
   several of tonight's incidents threw no error at all.
