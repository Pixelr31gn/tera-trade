// First-time setup for the Tera Trade .exe deliverable (see
// scripts/build-exe.ps1) -- compiled to tera-trade-setup.exe via Node SEA.
// Mirrors scripts/setup.ps1's logic (auto-generate API_KEY/POSTGRES_PASSWORD,
// start Docker Compose, run migrations) but only prompts the recipient for
// the one thing that's actually unique per-licensee: the license key. Only
// uses Node builtins (child_process, fs, path, crypto, readline) -- nothing
// SEA can't handle, since this doesn't touch Prisma/Playwright itself, only
// spawns `docker` and the bundled Prisma CLI as separate real processes.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const baseDir = path.dirname(process.execPath);
const envPath = path.join(baseDir, "app", ".env");
const envExamplePath = path.join(baseDir, ".env.example");
const composeFile = path.join(baseDir, "docker-compose.yml");
const nodeExe = path.join(baseDir, "node", "node.exe");
const prismaCli = path.join(baseDir, "app", "node_modules", "prisma", "build", "index.js");

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function readEnvLines() {
  return fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
}

function getEnvValue(lines, key) {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

function setEnvValue(lines, key, value) {
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines;
}

// TEMPORARY (2026-08-01, operator request): embedded here instead of
// prompted for, until a real per-installation subscription check (the
// operator's stated plan: auto-stop the app after 30 days) replaces this.
// Remove this constant and restore the prompt-only flow below once that
// exists -- CLAUDE.md's own rule is "never commit or modify .env, license
// keys, or anything under src/core/license.ts" specifically to prevent this
// shape of change; the operator explicitly overrode it for this build only,
// aware that shipping this key baked into a rebuilt exe means anyone who
// gets a copy of that exe gets this license with no check at all.
const DEFAULT_LICENSE_KEY =
  "eyJsaWNlbnNlZFRvIjoiRWxpamFoIFdlYmIiLCJpc3N1ZWRBdCI6IjIwMjYtMDctMjBUMTg6NTQ6MzguNTk3WiIsImV4cGlyZXNBdCI6bnVsbH0.9ugC44tXSUTMksa3lsvg9enAjS-DvzsE-9JqAIDb53U";

// One shared interface for the whole script, not one per question -- creating
// and closing a fresh readline.Interface per prompt() call (confirmed live,
// 2026-07-29) can silently drop the next question's already-buffered answer:
// closing an interface doesn't hand off whatever the OS/stream already
// delivered to it, so a second question's answer arriving in the same
// underlying read as the first can vanish between one interface's close()
// and the next one's creation. A single long-lived interface across both
// questions removes the gap entirely.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt(question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// See scripts/exe-launcher.cjs's matching functions for the full "why" --
// same fix applied here for consistency, 2026-08-03, so first-time setup
// doesn't hit a harder-to-recover-from wall than the everyday launcher does
// if Docker Desktop just isn't running yet.
function findDockerDesktopExe() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "Docker Desktop.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker", "Docker", "Docker Desktop.exe"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function dockerInfoOk() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function isPostgresHealthy() {
  const check = spawnSync("docker", ["inspect", "--format={{.State.Health.Status}}", "teratrade-postgres"]);
  return !!(check.stdout && check.stdout.toString().trim() === "healthy");
}

function ensureDockerRunning() {
  if (dockerInfoOk()) return true;

  console.log("Docker isn't running yet -- starting Docker Desktop...");
  const exePath = findDockerDesktopExe();
  if (!exePath) {
    console.error(
      "\nCould not find Docker Desktop installed in either the usual per-user or Program Files location.\n" +
        "Install it from https://www.docker.com/products/docker-desktop, start it once, then re-run this setup."
    );
    return false;
  }
  spawn(exePath, [], { detached: true, stdio: "ignore" }).unref();

  console.log("Waiting for Docker Desktop to finish starting (this can take a couple of minutes on a cold start)...");
  for (let i = 0; i < 90; i++) {
    if (dockerInfoOk()) return true;
    sleep(2000);
  }
  console.error("\nDocker Desktop did not become ready within 3 minutes. Open it manually, wait for it to finish starting, then re-run this setup.");
  return false;
}

async function main() {
  console.log("=== Tera Trade setup ===\n");

  const isNew = !fs.existsSync(envPath);
  if (isNew) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log("Created app\\.env from the template.");
  } else {
    console.log("app\\.env already exists -- leaving values you've already set as-is.");
  }

  let lines = readEnvLines();

  const currentApiKey = getEnvValue(lines, "API_KEY");
  if (!currentApiKey || currentApiKey === "change-me-dev-key") {
    lines = setEnvValue(lines, "API_KEY", randomHex(24));
    console.log("Generated a real API_KEY.");
  }

  let pgPassword = getEnvValue(lines, "POSTGRES_PASSWORD");
  if (!pgPassword) {
    pgPassword = randomHex(24);
    lines = setEnvValue(lines, "POSTGRES_PASSWORD", pgPassword);
    console.log("Generated a real POSTGRES_PASSWORD.");
  }
  lines = setEnvValue(lines, "DATABASE_URL", `postgresql://teratrade:${pgPassword}@localhost:5432/teratrade?schema=public`);

  if (!getEnvValue(lines, "LICENSE_KEY")) {
    // See DEFAULT_LICENSE_KEY's comment above -- temporarily skips the
    // prompt entirely instead of asking, until real subscription enforcement
    // exists. The original prompt-based flow (kept here in history, not
    // deleted, for when this is reverted):
    //   const licenseKey = await prompt("License key: ");
    const licenseKey = DEFAULT_LICENSE_KEY;
    lines = setEnvValue(lines, "LICENSE_KEY", licenseKey);
    try {
      const payloadB64 = licenseKey.split(".")[0];
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      lines = setEnvValue(lines, "LICENSED_TO", payload.licensedTo);
      console.log(`License recognized for: ${payload.licensedTo} (embedded default license key -- see exe-setup.cjs's DEFAULT_LICENSE_KEY comment)`);
    } catch {
      console.error("\nEmbedded default license key is malformed -- this is a packaging bug, not something re-running setup will fix.");
      process.exitCode = 1;
      return;
    }
  }
  rl.close(); // only ever used for the one license-key question above

  fs.writeFileSync(envPath, lines.join("\n"));

  if (!ensureDockerRunning()) {
    process.exitCode = 1;
    return;
  }

  // Checked before calling `docker compose up` at all -- if a
  // "teratrade-postgres" container already exists (e.g. this setup is being
  // re-run, or a container from elsewhere is already up), a fresh `compose
  // up` from a project that doesn't already own that container name fails
  // outright with a name conflict instead of adopting it (confirmed live,
  // 2026-08-03 -- see exe-launcher.cjs's matching comment).
  let healthy = isPostgresHealthy();
  if (healthy) {
    console.log("\nLocal Postgres is already running and healthy.");
  } else {
    console.log("\nStarting local Postgres in Docker...");
    let result = spawnSync("docker", ["compose", "-f", composeFile, "--env-file", envPath, "up", "-d"], { stdio: "inherit" });
    if (result.status !== 0) {
      console.error("\ndocker compose up failed -- see the error above.");
      process.exitCode = 1;
      return;
    }

    console.log("Waiting for Postgres to become healthy...");
    for (let i = 0; i < 30; i++) {
      if (isPostgresHealthy()) {
        healthy = true;
        break;
      }
      sleep(2000);
    }
    if (!healthy) {
      console.error("\nPostgres didn't report healthy in time -- check 'docker compose logs' from this folder.");
      process.exitCode = 1;
      return;
    }
  }
  console.log("Postgres is up.");

  console.log("Applying database schema...");
  result = spawnSync(nodeExe, [prismaCli, "migrate", "deploy"], { stdio: "inherit", cwd: path.join(baseDir, "app"), env: process.env });
  if (result.status !== 0) {
    console.error("\nMigration failed -- see the error above. Re-run this setup once fixed.");
    process.exitCode = 1;
    return;
  }

  console.log("\nSetup complete! Double-click tera-trade.exe to start.");
  console.log("(One more one-time step: the app drives your real TopstepX account through Chrome -- see docs/BROWSER_WATCH.md for the login step.)");
}

main();
