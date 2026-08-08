// Combined backend+frontend launcher for the Tera Trade .exe deliverable
// (see scripts/build-exe.ps1) -- compiled to tera-trade.exe via Node SEA.
// Replaces the earlier two-separate-exes design (backend/scripts/launcher.cjs
// + frontend/serve.cjs) with one double-click: spawns the backend as a real,
// separate `node.exe` process against the portable `app/` folder (real
// dist/ + real node_modules/, untouched -- Prisma/Playwright need to run
// completely normally, see launcher.cjs's original header comment for why
// they can't be SEA-embedded), and serves the static frontend directly
// in-process via a plain node:http server (the same dependency-free logic
// frontend/serve.cjs had, inlined here rather than requiring a separate
// file, since SEA's embedded require() can only resolve Node builtins).
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const baseDir = path.dirname(process.execPath);
const nodeExe = path.join(baseDir, "node", "node.exe");
const appDir = path.join(baseDir, "app");
const backendEntry = path.join(appDir, "dist", "index.js");
const outDir = path.join(baseDir, "out");
const FRONTEND_PORT = process.env.FRONTEND_PORT ? Number(process.env.FRONTEND_PORT) : 3000;

// Tiny standalone .env reader (deliberately not shared with exe-setup.cjs --
// same dependency-free, one-file-per-SEA-binary convention as everything
// else here) -- just enough to know whether the backend is about to launch
// its own dedicated debug-profile Chrome (see backend/src/browserWatch/
// chromeLauncher.ts) and which CDP port to reach it on, so the dashboard can
// open as a second tab in that SAME window instead of a separate one.
function readEnvValue(key, fallback) {
  try {
    const text = fs.readFileSync(path.join(appDir, ".env"), "utf-8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    const value = line ? line.slice(key.length + 1).trim() : "";
    return value || fallback;
  } catch {
    return fallback;
  }
}

console.log("Starting Tera Trade backend...");
const backend = spawn(nodeExe, [backendEntry], { stdio: "inherit", cwd: appDir, env: process.env });
backend.on("error", (err) => {
  console.error("Failed to launch the backend process:", err);
  process.exit(1);
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function resolveFile(urlPath) {
  const safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    path.join(outDir, safePath),
    path.join(outDir, safePath, "index.html"),
    path.join(outDir, `${safePath}.html`),
  ];
  for (const candidate of candidates) {
    try {
      return { path: candidate, data: await fsp.readFile(candidate) };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  const resolved = (await resolveFile(urlPath)) ?? (await resolveFile("/404"));
  if (!resolved) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(resolved.path);
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
  res.end(resolved.data);
});

function openInDefaultBrowser(url) {
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
}

function httpRequestOk(url, method) {
  return new Promise((resolve) => {
    const req = http.request(url, { method, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Opens the dashboard as a second tab in the SAME debug-profile Chrome
// window the backend launches for TopstepX (chromeLauncher.ts), instead of
// a separate window under whatever the OS default browser/profile is --
// operator feedback 2026-07-30: seeing two disconnected Chrome windows
// (different profiles) reads as broken even though each one individually
// works fine. Chrome's own DevTools Protocol supports this directly:
// hitting `<cdpUrl>/json/new?<url>` opens `<url>` as a new tab in that exact
// running instance -- but this specific Chrome build (150.x, confirmed live
// 2026-07-30) rejects it over GET with 405 ("This action supports only PUT
// verb"), unlike older CDP docs/examples that show GET -- must be PUT.
// Falls back to the plain default-browser open whenever browser mode isn't
// in use at all, or the debug Chrome never becomes reachable in time (never
// load-bearing -- the dashboard is always separately reachable by just
// typing the URL).
async function openDashboard(url) {
  const chromeAutoLaunch = readEnvValue("CHROME_AUTO_LAUNCH", "true") !== "false";
  const priceSource = readEnvValue("PRICE_SOURCE", "yahoo");
  const accountSource = readEnvValue("ACCOUNT_SOURCE", "simulated");
  const usesDebugChrome = chromeAutoLaunch && (priceSource === "browser" || accountSource === "browser");

  if (usesDebugChrome) {
    const cdpUrl = readEnvValue("BROWSER_CDP_URL", "http://localhost:9222");
    // The backend launches its own debug Chrome asynchronously during its own
    // startup (chromeLauncher.ts) -- poll for a while rather than assume it's
    // already up the instant this process's own server starts listening.
    // Generous on purpose: this process's own server.listen() callback fires
    // almost immediately (nothing blocks it), while the backend needs several
    // seconds of its own startup before it even STARTS launching Chrome, plus
    // up to chromeLauncher.ts's own 20s READY_TIMEOUT_MS after that -- a
    // same-length 20s window here raced against that and lost (confirmed
    // live, 2026-07-30: Chrome became ready right as this deadline expired).
    // A longer wait here costs nothing on the failure path (still falls back
    // to a plain browser open below) but avoids that race on the success path.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (await httpRequestOk(`${cdpUrl}/json/version`, "GET")) {
        const opened = await httpRequestOk(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, "PUT");
        if (opened) return;
        break; // CDP is up but opening a tab failed -- fall back below
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  openInDefaultBrowser(url);
}

server.listen(FRONTEND_PORT, () => {
  const url = `http://localhost:${FRONTEND_PORT}`;
  console.log(`Tera Trade dashboard: ${url}`);
  // Nice-to-have, not load-bearing: open the dashboard automatically so the
  // whole "double-click and go" experience doesn't need a third manual step
  // (typing the URL into a browser). Failure here is silently ignored --
  // the app is fully usable either way.
  openDashboard(url).catch(() => openInDefaultBrowser(url));
});

function shutdown() {
  backend.kill();
  server.close();
  process.exit(0);
}

backend.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
