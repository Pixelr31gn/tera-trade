# Tera Trade

A trading platform for Topstep-funded futures accounts (ES, NQ and GC, traded as their micro
contracts): real-time market data, a rule-based scoring engine (several strategy versions,
v1-v7, shadow-scored in parallel on every signal), a full risk engine with position sizing and
stops, market-regime detection, and a plain-English explanation behind every decision. It reads
your account and prices directly off TopstepX's own web platform in a dedicated, auto-managed
Chrome tab -- no broker API key required.

See [LICENSE.md](LICENSE.md) for the terms of use. No license key is needed to run it.

**This software can place real orders against a real funded account.** It ships in `paper`
mode (a simulated account, no real orders) and stays there until *you* change several settings
on purpose -- see "Trading modes". Watch it trade in paper mode for a long while before you
consider anything else. Trading futures carries a substantial risk of loss; nothing here is
financial advice, and the strategies are not a guarantee of anything.

## What you need

- **Windows 10/11.** Everything below has been run and tested on Windows. The `scripts\*.ps1`
  helpers are PowerShell. The Node and Docker parts are cross-platform, but macOS and Linux are
  untested, so treat those as "you're on your own" for now.
- **Node.js 20 or newer** (https://nodejs.org)
- **Docker Desktop**, running -- Tera Trade keeps its data in a local Postgres container that
  it starts for you (https://www.docker.com/products/docker-desktop)
- **Google Chrome** -- the app launches and manages its own separate Chrome profile; your
  everyday browsing is never touched
- **A TopstepX account** you can log into
- **git**, so you can pull updates

## Install (Windows, the easy way)

From the repo root, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

That one script checks Node/Docker/Chrome, installs both apps' dependencies, creates the `.env`
files, generates a random API key and database password for you, starts Postgres in Docker,
applies the database schema, and asks you to choose a dashboard password.

Then start everything:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

Open the dashboard at **http://localhost:3000** and sign in with the password you chose. The
API health check is at http://localhost:8000/health.

## Install (manual)

**`.env` lives in `backend/`, not the repo root** -- Prisma's CLI and the app's own env loader
only look next to `backend/`'s files. (The repo-root `.env` is only for Docker's Postgres
password.)

1. **Database** (from the repo root):
   ```
   copy .env.example .env
   ```
   Edit `.env` and set `POSTGRES_PASSWORD` to a long random value, then:
   ```
   docker compose up -d
   ```
2. **Backend**:
   ```
   cd backend
   copy .env.example .env
   ```
   In `backend/.env` set `DATABASE_URL` (same password as above,
   `postgresql://teratrade:<password>@localhost:5432/teratrade?schema=public`) and change
   `API_KEY` to a long random string -- **do not leave the default `change-me-dev-key`**: the
   backend listens on all network interfaces, and that default is public. Then:
   ```
   npm install
   npx prisma migrate deploy
   npm run auth:set-password
   npm run dev
   ```
   `auth:set-password` prompts for the dashboard password and writes its hash into `.env`;
   the dashboard refuses every login until you've run it.
3. **Dashboard** (a second terminal):
   ```
   cd frontend
   copy .env.example .env.local
   npm install
   npm run dev
   ```
4. Open **http://localhost:3000**.

## First run: logging into TopstepX

On startup the backend launches its own Chrome window (a separate profile -- see
`backend/src/browserWatch/chromeLauncher.ts`) pointed at TopstepX. The first time it's a fresh,
logged-out profile: **log into TopstepX in that window once.** The session persists across
restarts. If you ever need to do it by hand (e.g. `CHROME_AUTO_LAUNCH=false`), see
[docs/BROWSER_WATCH.md](docs/BROWSER_WATCH.md).

## Trading modes

`TRADING_MODE` in `backend/.env` controls what the engine may do. **A fresh `.env` copied from
`.env.example` is `paper`, with dry-run on.**

- **`analysis_only`** -- scores setups and shows recommendations; places no order anywhere,
  not even simulated.
- **`paper`** -- requires `BROKER_KIND=simulated`. Trades a simulated account against real live
  prices with the same risk rules as live. **Start here and stay here for a while.**
- **`live`** -- real orders on your real account. Needs `BROKER_KIND=projectx` or
  `browser_control`, `LIVE_TRADING_CONFIRMED=true`, and (for `browser_control`)
  `DRY_RUN_ORDERS=false` -- separate, deliberate switches, so nothing escalates from paper to
  live by itself. Leave `KILL_SWITCH_ENABLED=true` (the default): it's the account-wide
  daily-loss/drawdown auto-stop. Read [docs/BROWSER_CONTROL.md](docs/BROWSER_CONTROL.md) first.

## Updating to a newer build

Stop Tera Trade first (close the backend and dashboard windows), then from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1
```

It pulls the latest code, reinstalls dependencies, and applies any new database migrations.
Then run `scripts\start.ps1` again. Your `.env` files and your data are never touched by an
update.

By hand, that is: `git pull --ff-only`, `npm install` in `backend/` and in `frontend/`, then
`npx prisma migrate deploy` in `backend/`.

New releases may add settings. Every setting has a default, so your existing `backend/.env`
keeps working, but compare it with `backend/.env.example` if you want to see what's new. If
`git pull` refuses because you've edited tracked files, keep or stash your edits first --
the update script deliberately won't overwrite your work.

## Optional: the AI assistant

The dashboard has an AI assistant page that can also build a daily support/resistance plan for
each session. It is **off by default** (`ASSISTANT_ENABLED=false`). To use it you need either a
Gemini API key (`GEMINI_API_KEY`) or a local Ollama server (`ASSISTANT_PROVIDER=ollama`), plus
`ASSISTANT_ENABLED=true`. Its ability to take real actions is a second, separate switch
(`ASSISTANT_ACTIONS_CONFIRMED`) and stays off until you turn it on.

## Running the tests

```
cd backend
npm test
```

Most tests are pure unit tests and need no database. The few that exercise the engine against a
real Postgres are skipped automatically unless `TEST_DATABASE_URL` points at a reachable,
migrated database.

## Architecture and docs

```
backend/   Node.js + TypeScript (Fastify): broker abstraction, market data, analytics, regime,
           news, scoring, risk, strategy, execution, explanation, and the engine loop that ties
           them together. Prisma ORM against a local Postgres (Docker).
frontend/  Next.js dashboard: overview, recommendations, positions, performance, journal,
           strategy comparison, sessions, assistant, settings.
scripts/   Windows setup / start / update helpers, and the packaged-.exe build.
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- module map, data flow, design rationale
- [docs/BUILD_HISTORY.md](docs/BUILD_HISTORY.md) -- how the system got to its current state
- [docs/BROWSER_WATCH.md](docs/BROWSER_WATCH.md) -- the read-only account/price data source
- [docs/BROWSER_CONTROL.md](docs/BROWSER_CONTROL.md) -- real order placement via click automation
- [LICENSE.md](LICENSE.md) -- license terms

## Known limitations

- **`ProjectXGatewayBroker` has never been integration-tested** against a live account. The
  browser-attach path (no API key needed) is what has actually been run and verified.
- **Rule-based scoring, not a trained ML model.** The scorers are documented heuristics with a
  historical-outcome adjustment layered on top; `scoring/training.ts` is dormant on purpose.
- **Single Chrome tab, single account.** The live data path depends on one logged-in browser tab
  on the machine running the backend -- see docs/BROWSER_WATCH.md.
- **Historical intraday data is 5-minute bars (~60 days).** That is the binding constraint on
  any backtesting or replay work.
