# Terra Trade

A trading platform for Topstep-funded futures accounts: real-time market data, a year+ of
historical price history in TimescaleDB, statistical performance analysis, market-regime
detection, news/economic-calendar risk awareness, a trade scoring engine gated by a strict
confidence threshold, and a full risk engine with dynamic position sizing and ATR/structure
stops -- all with a plain-English explanation behind every decision.

**Status: Phase 0.** The system runs end-to-end against a simulated broker and free market
data, locked to `analysis_only` mode. See [docs/ROLLOUT_PLAN.md](docs/ROLLOUT_PLAN.md) before
enabling paper or live trading.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module breakdown. Short version:

```
backend/   FastAPI app -- broker abstraction, market data, analytics, regime, news,
           scoring, risk, strategy, execution, explanation, and the engine loop that
           wires them together.
frontend/  Next.js dashboard -- overview, recommendations, positions, performance,
           journal, settings.
infra/     docker-compose.yml (TimescaleDB + backend + frontend).
```

## Quick start

1. **Prerequisites**: Docker Desktop. (Python 3.11+ and Node 20+ only if you want to run
   services outside Docker.)
2. Copy the environment template and fill in values (the defaults work for Phase 0):
   ```
   cp .env.example .env
   ```
3. Bring up the stack:
   ```
   cd infra
   docker compose up --build
   ```
4. Run database migrations (first time only):
   ```
   docker compose exec backend poetry run alembic upgrade head
   ```
5. Kick off the historical backfill (1 year of daily bars + trailing week of 1-minute bars,
   for ES/NQ/CL/GC) and pull the current economic calendar:
   ```
   curl -X POST http://localhost:8000/api/backfill/run -H "X-API-Key: change-me-dev-key"
   ```
6. Open the dashboard at http://localhost:3000 and the API docs at http://localhost:8000/docs.

The engine starts polling for new bars immediately and will begin producing regime
snapshots, scored setups, and plain-English explanations in the dashboard's Overview and
Recommendations pages -- all in `analysis_only` mode, so nothing is ever executed yet.

## Running tests

```
cd backend
poetry install
poetry run pytest
```

Most tests are pure unit tests (analytics, risk, regime, scoring, strategies, explanations)
and need no database. One integration test
(`tests/test_engine_integration.py`) exercises the full engine loop against a real
Postgres and is skipped automatically unless `TEST_DATABASE_URL` (or `DATABASE_URL`) points
at a reachable database.

## Known limitations (Phase 0, by design)

- **No ProjectX Gateway credentials yet.** `ProjectXGatewayBroker` is implemented against
  the documented API but has not been integration-tested against a live account.
- **Free historical data.** 1-minute bars are only available for the trailing ~7 days
  (Yahoo Finance's own limit); the 1-year+ history requirement is satisfied at daily
  granularity (`bars_daily`). See `app/market_data/backfill.py`.
- **Rule-based scoring model.** There's no trade history to train a real ML model on yet;
  `app/scoring/rule_scorer.py` is a documented, transparent heuristic. `app/scoring/training.py`
  is ready to fit a calibrated model once enough closed trades exist.
- This environment had neither Python nor Docker installed, so the backend test suite and
  `docker compose up` were not executed end-to-end during this build -- only the frontend
  (`npm run build`) was verified to compile. Run the Quick Start steps above to validate the
  rest before trusting it further.
