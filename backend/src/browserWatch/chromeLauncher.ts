/**
 * Auto-launches a debug-mode Chrome instance on app startup, so a user just
 * runs Tera Trade and it works -- rather than having to remember to manually
 * start Chrome with --remote-debugging-port every time, which is what every
 * session before this one required (and forgetting it, or Chrome crashing
 * mid-session, was a recurring real failure mode). This is the "no API,
 * distribute the software" model: each user's own Chrome, on their own
 * machine, logged into their own TopstepX -- see docs/BROWSER_WATCH.md.
 *
 * Safe to call on every app start (including every tsx watch hot-reload
 * during development): it first checks whether a debug Chrome is already
 * responding on the configured port and does nothing if so, rather than
 * spawning a duplicate Chrome window on every restart.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { childLogger } from "../core/logger.js";
import { connectToChrome } from "./cdpClient.js";

const logger = childLogger("chromeLauncher");

const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 20_000;

// The frontend (`npm run dev` in frontend/) is a separate process that
// start.ps1 launches ~3s after the backend and that takes many more seconds
// to finish its first Next.js compile -- so the dashboard is essentially
// never actually reachable yet at the point ensureDebugChromeRunning runs
// during a normal cold start. Polling for it here (rather than giving up on
// the first failed request) is what makes "always open a dashboard tab"
// true in practice instead of only on a lucky-timing restart.
const DASHBOARD_READY_POLL_INTERVAL_MS = 1000;
const DASHBOARD_READY_TIMEOUT_MS = 60_000;

async function isCdpResponding(cdpUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${cdpUrl}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// Common install locations across Windows, macOS, and Linux -- checked in
// order, first match wins. CHROME_EXECUTABLE_PATH overrides this entirely.
function findChromeExecutable(): string | null {
  const candidates: string[] =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"];

  return candidates.find((p) => p && existsSync(p)) ?? null;
}

function defaultUserDataDir(): string {
  const base = process.platform === "win32" ? (process.env.LOCALAPPDATA ?? os.homedir()) : os.homedir();
  return path.join(base, "TeraTrade", "chrome-debug-profile");
}

function extractPort(cdpUrl: string): number {
  return Number(new URL(cdpUrl).port) || 9222;
}

async function waitForDashboardReachable(dashboardUrl: string): Promise<boolean> {
  const deadline = Date.now() + DASHBOARD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(dashboardUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {
      // Frontend dev server isn't up yet -- keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, DASHBOARD_READY_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Opens the dashboard as a second tab in the same debug Chrome session, next
 * to the TopstepX tab, once the frontend dev server is actually reachable.
 * Reuses cdpClient's cached connectOverCDP connection rather than opening an
 * independent one -- see cdpClient.ts's 2026-07-21 comment on why a second
 * simultaneous connectOverCDP call is a real, previously-hit hang risk.
 * Checks existing tabs first so a tsx watch hot-reload (this whole function
 * runs again on every one) doesn't pile up duplicate dashboard tabs. Never
 * throws, same posture as the rest of this module -- worst case, the user
 * opens the dashboard tab themselves, same as every version before this one.
 */
async function ensureDashboardTabOpen(cdpUrl: string, dashboardUrl: string): Promise<void> {
  const reachable = await waitForDashboardReachable(dashboardUrl);
  if (!reachable) {
    logger.warn({ dashboardUrl }, "dashboard_not_reachable_skipping_tab");
    return;
  }
  try {
    const browser = await connectToChrome(cdpUrl);
    const origin = new URL(dashboardUrl).origin;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith(origin)) {
          logger.info({ dashboardUrl }, "dashboard_tab_already_open");
          return;
        }
      }
    }
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    await page.goto(dashboardUrl);
    logger.info({ dashboardUrl }, "opened_dashboard_tab");
  } catch (err) {
    logger.warn({ dashboardUrl, err: err instanceof Error ? err.message : String(err) }, "dashboard_tab_open_failed");
  }
}

/**
 * Ensures a debug-mode Chrome is running and its CDP port is responding.
 * No-op if one already is. Never throws -- a failure here just means
 * BrowserWatcher's existing poll-and-retry takes over (and logs its own
 * warnings), same as if the user had started Chrome manually and gotten it
 * wrong. Logs clearly either way so the cause is visible in the log.
 */
export async function ensureDebugChromeRunning(opts: {
  cdpUrl: string;
  executablePath: string | undefined;
  userDataDir: string | undefined;
  startUrl: string;
  dashboardUrl?: string;
}): Promise<void> {
  // Fire-and-forget: waits up to a minute for the frontend dev server, which
  // must not hold up broker.connect() and the rest of main()'s startup
  // sequence below. Never rejects (see ensureDashboardTabOpen's own
  // try/catch), but .catch() is cheap insurance against turning this into an
  // unhandled rejection if that ever changes.
  if (opts.dashboardUrl) {
    void ensureDashboardTabOpen(opts.cdpUrl, opts.dashboardUrl).catch(() => {});
  }

  if (await isCdpResponding(opts.cdpUrl)) {
    logger.info({ cdpUrl: opts.cdpUrl }, "debug_chrome_already_running");
    return;
  }

  // `||`, not `??` -- CHROME_EXECUTABLE_PATH/CHROME_DEBUG_USER_DATA_DIR come
  // through zod's `z.string().optional()` (core/config.ts), which yields ""
  // (not undefined) for a blank `KEY=` line in .env -- the standard, default,
  // documented way to leave these unset. `??` only falls through on
  // null/undefined, so an empty string silently skipped auto-detection
  // entirely (confirmed live, 2026-07-29: chrome_executable_not_found fired
  // immediately on every run with the default blank config, even with a real
  // Chrome install sitting at one of findChromeExecutable's own candidate
  // paths) -- this broke the auto-launch feature's whole purpose for anyone
  // using the recommended default (blank) configuration.
  const executable = opts.executablePath || findChromeExecutable();
  if (!executable) {
    logger.warn(
      { platform: process.platform },
      "chrome_executable_not_found -- set CHROME_EXECUTABLE_PATH, or start Chrome with --remote-debugging-port manually"
    );
    return;
  }

  const userDataDir = opts.userDataDir || defaultUserDataDir();
  const port = extractPort(opts.cdpUrl);

  logger.info({ executable, userDataDir, port }, "launching_debug_chrome");
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      // A brand-new user-data-dir (first-ever launch of this profile) makes
      // Chrome show its own "Sign in to Chrome" / welcome interstitial
      // instead of navigating to the requested start URL -- these are the
      // standard automation flags (also used by Puppeteer/Playwright) that
      // suppress it, confirmed necessary: without them, the very first
      // auto-launch opened to chrome://intro/ with no topstepx.com tab at all.
      "--no-first-run",
      "--no-default-browser-check",
      opts.startUrl,
    ],
    { detached: true, stdio: "ignore" }
  );
  // Detached + unref'd: Chrome keeps running (and the user keeps using it)
  // independently of this Node process's lifetime -- a backend restart
  // must not kill the user's browser tab out from under them.
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isCdpResponding(opts.cdpUrl)) {
      logger.info({ cdpUrl: opts.cdpUrl }, "debug_chrome_ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  logger.warn({ cdpUrl: opts.cdpUrl }, "debug_chrome_did_not_become_ready_in_time");
}
