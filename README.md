# Tera Trade

A trading platform for Topstep-funded futures accounts (currently ES/NQ): real-time market
data, a rule-based scoring engine (three shadow-scored strategy versions per signal, v1/v2/v3),
a full risk engine with dynamic position sizing and ATR/structure stops, market-regime
detection, and a plain-English explanation behind every decision. Reads your account and prices
directly off TopstepX's own web platform in a dedicated, auto-managed Chrome tab -- no broker
API key required.

**This is licensed software.** See [LICENSE.md](LICENSE.md) before installing or distributing
it -- the app will not start without a valid license key (Section "License setup" below).

**Status**: runs end-to-end against a simulated broker (`paper` mode) with real live market
data. Live trading (real orders on a real account) exists but requires four independent,
explicit opt-ins -- see "Trading modes" below -- and should not be enabled until you've watched
paper mode trade for a meaningful stretch of time.

## Architecture

```
backend/   Node.js + TypeScript (Fastify) -- broker abstraction, market data, analytics,
           regime, news, scoring, risk, strategy, execution, explanation, and the engine
           loop that wires them together. Prisma ORM against a hosted Postgres (Neon).
frontend/  Next.js dashboard -- overview, recommendations, positions, performance,
           journal, strategy comparison, settings.
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/BUILD_HISTORY.md](docs/BUILD_HISTORY.md)
for the full module breakdown and how the system got to its current state.

## Prerequisites

- **Node.js 20+**
- **Google Chrome** (the app launches and manages its own dedicated debug-mode Chrome profile
  automatically -- see "First run" below. Your regular Chrome browsing is never touched.)
- A **free hosted Postgres database** ([neon.tech](https://neon.tech), no card required)
- A **TopstepX account** you can log into
- A **license key** (see below)

## License setup

The app refuses to start without a valid `LICENSE_KEY` + `LICENSED_TO` pair in `backend/.env`
(see [LICENSE.md](LICENSE.md) for the terms). If you were given a key, skip to "Install and
run." If you're the licensor issuing your own key:

```
cd backend
npm run license:generate -- "Recipient Name or Email"
```

That's it -- no setup needed first. (Advanced: this signs against a secret baked into
`src/core/license.ts` so every distributed copy can verify keys you issue; set
`LICENSE_SIGNING_SECRET` in your own `backend/.env` only if you want to override that default
for yourself specifically -- it won't affect copies you've already sent out.)

This prints a `LICENSED_TO` / `LICENSE_KEY` pair to give the recipient for their own
`backend/.env`. Each key is tied to the name/email it was issued for.

## Install and run

**`.env` lives in `backend/`, not the repo root** -- Prisma's CLI and the app's own env loader
both only look next to `backend/`'s own files.

1. **Create a database**: sign up at [neon.tech](https://neon.tech), create a project, copy its
   connection string.
2. **Configure**:
   ```
   cd backend
   cp .env.example .env
   ```
   Fill in `DATABASE_URL`, your license (`LICENSE_KEY`/`LICENSED_TO`), and `API_KEY` (any
   string -- this guards the API, keep it private). Everything else has a sane default.
3. **Install and migrate**:
   ```
   npm install
   npx prisma migrate deploy
   ```
4. **Start the backend**:
   ```
   npm run dev
   ```
   On first run this automatically launches a dedicated Chrome window (see "First run" below).
5. **In a second terminal**, start the dashboard (needs the *same* API key as the backend, or
   every call fails with 401):
   ```
   cd frontend
   npm install
   cp .env.example .env.local
   npm run dev
   ```
6. Open the dashboard at **http://localhost:3000**. Confirm the API is up at
   http://localhost:8000/health.

## First run: logging into TopstepX

The backend automatically launches its own Chrome window on startup (a separate profile from
your everyday browsing -- see `backend/src/browserWatch/chromeLauncher.ts`), pointed at
TopstepX. The very first time, it's a fresh, logged-out profile: **just log into TopstepX in
that window once.** The session persists across every future restart -- you only do this once
per machine.

If you ever need to do it manually (e.g. `CHROME_AUTO_LAUNCH=false`), see
[docs/BROWSER_WATCH.md](docs/BROWSER_WATCH.md).

## Trading modes

`TRADING_MODE` in `backend/.env` controls what the engine is allowed to do:

- **`analysis_only`** -- scores setups, shows recommendations, places no order anywhere (not
  even simulated).
- **`paper`** -- requires `BROKER_KIND=simulated`. Trades a simulated account against real live
  prices, full risk management enforced identically to live. **Start here, stay here for a
  while.**
- **`live`** -- real orders on your real account. Requires `BROKER_KIND=projectx` or
  `browser_control` *and* `LIVE_TRADING_CONFIRMED=true` -- two separate, deliberate flags, so
  nothing can escalate from paper to live by itself. Also keep `KILL_SWITCH_ENABLED=true` (the
  default) -- it's the account-wide daily-loss/drawdown auto-stop.

## Running tests

```
cd backend
npm test
```
Most tests are pure unit tests and need no database. `tests/engineIntegration.test.ts` exercises
the full engine loop against a real Postgres and is skipped automatically unless
`TEST_DATABASE_URL` (or `DATABASE_URL`) points at a reachable, migrated database.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- module map, data flow, design rationale
- [docs/BUILD_HISTORY.md](docs/BUILD_HISTORY.md) -- how the system was built, phase by phase
- [docs/BROWSER_WATCH.md](docs/BROWSER_WATCH.md) -- the read-only account/price data source
- [docs/BROWSER_CONTROL.md](docs/BROWSER_CONTROL.md) -- real order placement via click automation
- [LICENSE.md](LICENSE.md) -- license terms (draft template, see the note at the top of that file)

## Known limitations

- **No ProjectX Gateway credentials tested.** `ProjectXGatewayBroker` is implemented against
  the documented API but has never been integration-tested against a live account -- the
  browser-attach path (no API key needed) is what's actually been run and verified.
- **Rule-based scoring, not a trained ML model.** `scoring/ruleScorer.ts`/`ruleScorerV3.ts` are
  documented, transparent heuristics with a historical-outcome adjustment layered on top.
  `scoring/training.ts` (a hand-rolled logistic regression) is ready to fit a calibrated model
  once enough closed trades exist.
- **Single Chrome tab, single account.** The live data path depends on one already-logged-in
  browser tab on the machine running the backend -- see docs/BROWSER_WATCH.md for what that
  means for multi-user or hosted setups.
