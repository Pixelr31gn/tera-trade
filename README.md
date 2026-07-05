# Terra Trade

A trading platform for Topstep-funded futures accounts: real-time market data, a year+ of
historical price history, statistical performance analysis, market-regime detection,
news/economic-calendar risk awareness, a trade scoring engine gated by a strict confidence
threshold, and a full risk engine with dynamic position sizing and ATR/structure stops --
all with a plain-English explanation behind every decision.

**Status: Phase 0.** The system runs end-to-end against a simulated broker and free market
data, locked to `analysis_only` mode. See [docs/ROLLOUT_PLAN.md](docs/ROLLOUT_PLAN.md) before
enabling paper or live trading.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module breakdown. Short version:

```
backend/   Node.js + TypeScript (Fastify) -- broker abstraction, market data, analytics,
           regime, news, scoring, risk, strategy, execution, explanation, and the engine
           loop that wires them together. Prisma ORM against a hosted Postgres (Neon).
frontend/  Next.js dashboard -- overview, recommendations, positions, performance,
           journal, settings.
infra/     Optional docker-compose.yml, only useful if you install Docker Desktop later.
```

Originally spec'd with a Python/FastAPI backend and local TimescaleDB via Docker; both were
swapped out because neither Python nor Docker were available on the target machine. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what changed and why.

## Quick start (native, no Docker required)

**Prerequisites**: Node.js 20+ (already installed) and a free hosted Postgres database.

1. **Create a database**: sign up at [neon.tech](https://neon.tech) (free, no card), create a
   project, and copy its connection string.
2. Copy the environment template and fill in your `DATABASE_URL`:
   ```
   cp .env.example .env
   ```
3. Install backend dependencies and set up the database schema:
   ```
   cd backend
   npm install
   npx prisma migrate dev --name init
   ```
4. Start the backend:
   ```
   npm run dev
   ```
5. In a second terminal, install and start the frontend:
   ```
   cd frontend
   npm install
   npm run dev
   ```
6. Kick off the historical backfill (1 year of daily bars + trailing week of 1-minute bars,
   for ES/NQ/CL/GC) and pull the current economic calendar:
   ```
   curl -X POST http://localhost:8000/api/backfill/run -H "X-API-Key: change-me-dev-key"
   ```
7. Open the dashboard at http://localhost:3000 and confirm the API is up at
   http://localhost:8000/health.

The engine starts polling for new bars immediately and will begin producing regime
snapshots, scored setups, and plain-English explanations in the dashboard's Overview and
Recommendations pages -- all in `analysis_only` mode, so nothing is ever executed yet.

## Running tests

```
cd backend
npm test
```

Most tests are pure unit tests (analytics, risk, regime, scoring, strategies, explanations)
and need no database. One integration test (`tests/engineIntegration.test.ts`) exercises the
full engine loop against a real Postgres and is skipped automatically unless
`TEST_DATABASE_URL` (or `DATABASE_URL`) points at a reachable, already-migrated database.

## Optional: Docker

If you later install Docker Desktop, `infra/docker-compose.yml` builds and runs the backend
and frontend as containers (the database stays hosted on Neon either way -- there's no local
database container). `docker compose up --build` from `infra/`.

## Known limitations (Phase 0, by design)

- **No ProjectX Gateway credentials yet.** `ProjectXGatewayBroker` is implemented against
  the documented API but has not been integration-tested against a live account.
- **Free historical data.** 1-minute bars are only available for the trailing ~7 days
  (Yahoo Finance's own limit); the 1-year+ history requirement is satisfied at daily
  granularity (`bars_daily`). See `backend/src/marketData/backfill.ts`.
- **Plain Postgres, not TimescaleDB.** Neon's free tier doesn't support the TimescaleDB
  extension; 5m/15m/1h/1d bar rollups run as scheduled application-code queries
  (`backend/src/marketData/rollup.ts`) instead of native continuous aggregates.
- **Rule-based scoring model.** There's no trade history to train a real ML model on yet;
  `backend/src/scoring/ruleScorer.ts` is a documented, transparent heuristic.
  `backend/src/scoring/training.ts` (a hand-rolled logistic regression) is ready to fit a
  calibrated model once enough closed trades exist.
- This environment had neither Python, Docker, nor a database available, so end-to-end
  verification (`npm install` / `npm run build` / `npm test` / running the server against a
  real database) depends on you having created the Neon database and run the steps above.
