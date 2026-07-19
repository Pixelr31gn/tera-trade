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

const logger = childLogger("chromeLauncher");

const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 20_000;

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
}): Promise<void> {
  if (await isCdpResponding(opts.cdpUrl)) {
    logger.info({ cdpUrl: opts.cdpUrl }, "debug_chrome_already_running");
    return;
  }

  const executable = opts.executablePath ?? findChromeExecutable();
  if (!executable) {
    logger.warn(
      { platform: process.platform },
      "chrome_executable_not_found -- set CHROME_EXECUTABLE_PATH, or start Chrome with --remote-debugging-port manually"
    );
    return;
  }

  const userDataDir = opts.userDataDir ?? defaultUserDataDir();
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
