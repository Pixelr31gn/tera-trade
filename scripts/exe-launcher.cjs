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
const composeFile = path.join(baseDir, "docker-compose.yml");
const envPath = path.join(appDir, ".env");
const prismaCli = path.join(appDir, "node_modules", "prisma", "build", "index.js");
const FRONTEND_PORT = process.env.FRONTEND_PORT ? Number(process.env.FRONTEND_PORT) : 3000;

// Operator report, 2026-08-03: build-exe.ps1's original design documented
// Docker Desktop as "a one-time, manual prerequisite" -- start it yourself,
// then double-click tera-trade.exe. In practice that's an easy step to
// forget (a reboot stops Docker Desktop; nothing about launching Tera Trade
// itself reminds you it's not running), and the failure mode is an opaque
// Postgres-connection crash from the backend with no obvious fix. Since this
// exact recovery (start Docker Desktop if needed, wait for it, bring up
// Postgres, apply any pending migrations) was already done by hand once and
// worked cleanly, it belongs in the "every time" launcher itself instead of
// staying a documented-but-unenforced prerequisite.
function runToCompletion(command, args, opts) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: "inherit", ...opts });
    proc.on("exit", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

function dockerInfoOk() {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["info"], { stdio: "ignore" });
    proc.on("exit", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

// Docker Desktop's GUI exe isn't reliably on PATH even when the `docker` CLI
// is (the CLI lives under Docker Desktop's own resources\bin, which the
// installer does add to PATH; the GUI launcher itself doesn't need to be,
// and isn't, on most installs) -- check the two real install locations
// instead of assuming. Per-user AppData path listed first: confirmed on the
// machine this was developed on that Docker Desktop can be installed there
// instead of Program Files.
function findDockerDesktopExe() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "Docker Desktop.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker", "Docker", "Docker Desktop.exe"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function ensureDockerRunning() {
  if (await dockerInfoOk()) return true;

  console.log("Docker isn't running yet -- starting Docker Desktop...");
  const exePath = findDockerDesktopExe();
  if (!exePath) {
    console.error(
      "Could not find Docker Desktop installed in either the usual per-user or Program Files location.\n" +
        "Install it from https://www.docker.com/products/docker-desktop, start it once, then relaunch Tera Trade."
    );
    return false;
  }
  spawn(exePath, [], { detached: true, stdio: "ignore" }).unref();

  // Docker Desktop's own WSL2/VM boot can genuinely take a minute or two
  // cold (confirmed live) -- generous on purpose, same reasoning as
  // openDashboard's CDP poll below.
  console.log("Waiting for Docker Desktop to finish starting (this can take a couple of minutes on a cold start)...");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await dockerInfoOk()) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.error("Docker Desktop did not become ready within 3 minutes. Open it manually, wait for it to finish starting, then relaunch Tera Trade.");
  return false;
}

function isPostgresHealthy() {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["inspect", "--format={{.State.Health.Status}}", "teratrade-postgres"]);
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.on("exit", () => resolve(out.trim() === "healthy"));
    proc.on("error", () => resolve(false));
  });
}

async function waitForPostgresHealthy() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isPostgresHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

// Safe to run unconditionally on every launch, not just first-time setup --
// `prisma migrate deploy` is a no-op when the schema is already current, and
// this way a Tera Trade update that ships a new migration just works on the
// next ordinary double-click instead of needing a separate manual step.
async function ensurePostgresReady() {
  // Checked BEFORE calling `docker compose up` at all, not just skipped when
  // that command happens to no-op -- confirmed live (2026-08-03): if a
  // "teratrade-postgres" container already exists (e.g. still running from
  // an earlier launch, or started by a different checkout of this same
  // compose file), `docker compose up` from a project that doesn't already
  // consider itself that container's owner fails outright with a container
  // name conflict instead of adopting it. Since the one thing that actually
  // matters here is "is Postgres already reachable," check that directly
  // first and only fall through to actually starting it if it isn't.
  if (await isPostgresHealthy()) {
    console.log("Local Postgres is already running and healthy.");
  } else {
    console.log("Starting local Postgres (if not already running)...");
    if (!(await runToCompletion("docker", ["compose", "-f", composeFile, "--env-file", envPath, "up", "-d"], { cwd: baseDir }))) {
      console.error("docker compose up failed -- see the error above.");
      return false;
    }
    console.log("Waiting for Postgres to report healthy...");
    if (!(await waitForPostgresHealthy())) {
      console.error("Postgres didn't report healthy in time -- check 'docker compose logs' from this folder.");
      return false;
    }
  }
  console.log("Applying any pending database migrations...");
  if (!(await runToCompletion(nodeExe, [prismaCli, "migrate", "deploy"], { cwd: appDir, env: process.env }))) {
    console.error("Migration failed -- see the error above.");
    return false;
  }
  return true;
}

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

async function main() {
  console.log("Checking local Postgres...");
  if (!(await ensureDockerRunning()) || !(await ensurePostgresReady())) {
    console.error("\nCannot continue without a working local Postgres. Fix the issue above, then relaunch Tera Trade.");
    process.exitCode = 1;
    return;
  }

  console.log("Starting Tera Trade backend...");
  const backend = spawn(nodeExe, [backendEntry], { stdio: "inherit", cwd: appDir, env: process.env });
  backend.on("error", (err) => {
    console.error("Failed to launch the backend process:", err);
    process.exit(1);
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

  server.listen(FRONTEND_PORT, () => {
    const url = `http://localhost:${FRONTEND_PORT}`;
    console.log(`Tera Trade dashboard: ${url}`);
    // Nice-to-have, not load-bearing: open the dashboard automatically so the
    // whole "double-click and go" experience doesn't need a third manual step
    // (typing the URL into a browser). Failure here is silently ignored --
    // the app is fully usable either way.
    openDashboard(url).catch(() => openInDefaultBrowser(url));
  });
}

main();
