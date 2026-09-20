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
const dbSeedPath = path.join(baseDir, "app", "db-seed.dump");

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

// Same "salt:hex" scrypt format as backend/src/core/auth.ts's hashPassword/
// verifyPassword and backend/scripts/setPassword.ts (the source-repo
// equivalent of this prompt) -- keep all three in sync if this changes.
function hashPassword(password) {
  const salt = randomHex(16);
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

// Raw-mode masked input, separate from the `rl`/prompt() readline interface
// above (which is only ever used for the license-key question, currently
// dormant -- see DEFAULT_LICENSE_KEY's comment) -- mixing readline's
// line-buffered stdin handling with raw-byte reading on the same stream at
// the same time is asking for dropped input, so this only ever runs after
// `rl.close()`, from main().
function promptHiddenPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const onData = (char) => {
      const code = char.charCodeAt(0);
      const isEnter = code === 0x0a || code === 0x0d;
      const isEof = code === 0x04; // Ctrl-D
      const isInterrupt = code === 0x03; // Ctrl-C
      const isBackspace = code === 0x7f || code === 0x08;

      if (isEnter || isEof) {
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (isInterrupt) {
        process.stdout.write("\n");
        process.exit(1);
      }
      if (isBackspace) {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += char;
      process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

// Mandatory, unlike the license-key/API_KEY fields -- there is no usable
// fallback for a blank dashboard password (see core/auth.ts: login fails
// closed when AUTH_PASSWORD_HASH is unset), so this always prompts on a
// fresh .env and is skipped only once a password has actually been set.
async function ensureDashboardPassword(lines) {
  if (getEnvValue(lines, "AUTH_PASSWORD_HASH")) {
    console.log("Dashboard login password already set -- leaving it as-is.");
    return lines;
  }

  console.log("\nSet the password you'll use to log into the Tera Trade dashboard.");
  let password = "";
  while (password.length < 8) {
    password = await promptHiddenPassword("Dashboard login password (min 8 characters): ");
    if (password.length < 8) console.log("Too short -- try again.");
  }
  let confirm = await promptHiddenPassword("Confirm password: ");
  while (confirm !== password) {
    console.log("Passwords didn't match -- try again.");
    password = await promptHiddenPassword("Dashboard login password (min 8 characters): ");
    confirm = await promptHiddenPassword("Confirm password: ");
  }

  lines = setEnvValue(lines, "AUTH_PASSWORD_HASH", hashPassword(password));
  if (!getEnvValue(lines, "SESSION_SECRET")) {
    lines = setEnvValue(lines, "SESSION_SECRET", randomHex(32));
  }
  console.log("Dashboard login password set.");
  return lines;
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
// Regenerated for the 2.0.0 build (2026-08-13, operator request) -- the
// previous key was a leftover placeholder licensed to "Elijah Webb", not the
// actual operator; signed the same way with license.ts's own
// issueLicenseKey/DEFAULT_LICENSE_SIGNING_SECRET, licensedTo "Damalae"
// (this machine's git user.name -- the only concrete identity on hand),
// issuedAt 2026-08-13, no expiry.
const DEFAULT_LICENSE_KEY =
  "eyJsaWNlbnNlZFRvIjoiRGFtYWxhZSIsImlzc3VlZEF0IjoiMjAyNi0wOC0xM1QyMDozNjowMS4xNDZaIiwiZXhwaXJlc0F0IjpudWxsfQ.7zIEazP81WZTYEV9G3I1izdX-NTSd2oa-MkFeBN6Hks";

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

// True once the schema exists AND has at least one real row somewhere --
// used to decide whether restoring db-seed.dump is safe. A data-only
// pg_restore run against a database that already has rows would collide on
// primary keys (COPY-based restores don't upsert), so this must only ever
// run once, against a genuinely empty database -- never on a re-run of this
// setup, and never if the recipient already has their own data.
function databaseHasData() {
  const check = spawnSync("docker", [
    "exec", "teratrade-postgres", "psql", "-U", "teratrade", "-d", "teratrade",
    "-tAc", "SELECT EXISTS (SELECT 1 FROM scores LIMIT 1)",
  ]);
  return check.status === 0 && check.stdout && check.stdout.toString().trim() === "t";
}

// Restores the database snapshot bundled into this build (see
// scripts/build-exe.ps1's "Database seed" step -- 2026-08-13, operator
// request: "make sure a copy of this database gets added... so it doesn't
// have to re collect data"). Piped into the container's own pg_restore over
// stdin via `docker exec -i` -- same "run through the container's own client
// tools" pattern this project already used for its real Neon-to-local
// migration (see docs/BUILD_HISTORY.md), since neither this exe nor the
// recipient's machine has a native Postgres client installed. Best-effort:
// a missing seed file (this build didn't include one) or an already-populated
// database (this isn't the first run) both just skip quietly -- neither is
// an error worth failing setup over.
function restoreDbSeedIfPresent() {
  if (!fs.existsSync(dbSeedPath)) return;
  if (databaseHasData()) {
    console.log("Database already has data -- skipping the bundled snapshot restore.");
    return;
  }
  console.log("Restoring the bundled database snapshot (this may take a minute)...");
  const restore = spawnSync(
    "docker",
    ["exec", "-i", "teratrade-postgres", "pg_restore", "-U", "teratrade", "-d", "teratrade", "--data-only", "--disable-triggers"],
    { input: fs.readFileSync(dbSeedPath), stdio: ["pipe", "inherit", "inherit"] }
  );
  if (restore.status !== 0) {
    console.error("\nDatabase snapshot restore failed -- see the error above. The app will still work, just starting from an empty database. You can retry by deleting app\\db-seed.dump's failure state and re-running setup, or ask for help if this keeps happening.");
  } else {
    console.log("Database snapshot restored.");
  }
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

  lines = await ensureDashboardPassword(lines);

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

  // `docker compose up -d` above only applies POSTGRES_PASSWORD when it
  // initializes a brand-new, empty data volume. "teratrade-postgres" (name
  // and volume are shared across every Tera Trade version/build on a given
  // machine -- see docker-compose.yml) can already exist from an earlier
  // install, in which case the isPostgresHealthy() check above adopted it
  // as-is, still running whatever password it was first initialized with --
  // not necessarily this .env's freshly-generated one. Confirmed live
  // (2026-08-13): a fresh install generated a new POSTGRES_PASSWORD while an
  // old container/volume from a prior build was still around and healthy,
  // and `migrate deploy` failed with Prisma P1000 (auth failed) because the
  // two never matched. Unconditionally forcing the role's password to match
  // .env here makes this self-healing regardless of whether Postgres was
  // just created or adopted -- docker exec's local-socket connection is
  // trust-authenticated by the official postgres image's default
  // pg_hba.conf, so this doesn't need the old password to succeed.
  console.log("Syncing local Postgres role password...");
  const syncPassword = spawnSync("docker", [
    "exec", "teratrade-postgres", "psql", "-U", "teratrade", "-d", "teratrade",
    "-c", `ALTER USER teratrade WITH PASSWORD '${pgPassword}'`,
  ], { stdio: "inherit" });
  if (syncPassword.status !== 0) {
    console.error("\nCould not sync the Postgres role password -- see the error above.");
    process.exitCode = 1;
    return;
  }

  console.log("Applying database schema...");
  result = spawnSync(nodeExe, [prismaCli, "migrate", "deploy"], { stdio: "inherit", cwd: path.join(baseDir, "app"), env: process.env });
  if (result.status !== 0) {
    console.error("\nMigration failed -- see the error above. Re-run this setup once fixed.");
    process.exitCode = 1;
    return;
  }

  restoreDbSeedIfPresent();

  console.log("\nSetup complete! Double-click tera-trade.exe to start.");
  console.log("(One more one-time step: the app drives your real TopstepX account through Chrome -- see docs/BROWSER_WATCH.md for the login step.)");
}

main();
