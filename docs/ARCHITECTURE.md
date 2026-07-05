# Architecture

## Why Node.js/TypeScript and Neon, not Python/Docker/TimescaleDB

The system was originally built as a Python/FastAPI backend with TimescaleDB running via
Docker Compose. Neither Python nor Docker were actually installed on the target Windows
machine, and installing them hit repeated obstacles. Rather than block on tooling, the
backend was rewritten in Node.js/TypeScript (Node was already installed) against a free
hosted Postgres (Neon), which needs nothing installed locally beyond Node itself. The
design -- module boundaries, database schema, API contracts, mode-gated execution -- is
unchanged; only the runtime and database engine changed. Two concrete consequences:

- **No TimescaleDB extension.** Neon's free tier is plain Postgres. `bars_1m`,
  `regime_history`, `scores`, and `equity_curve` are ordinary indexed tables, and 5m/15m/1h/1d
  bar rollups are computed by scheduled application code (`marketData/rollup.ts`) instead of
  TimescaleDB continuous aggregates.
- **No native ML library.** There's no mature, dependency-free equivalent of scikit-learn in
  the Node ecosystem, so `scoring/training.ts` hand-rolls a logistic regression (gradient
  descent + L2 regularization) instead of using a boosted-tree library. Logistic regression
  trained by maximum likelihood is already a properly calibrated probabilistic model, which
  is what actually matters for the scoring gate.

## Data flow

```
LiveBarPoller (Yahoo Finance poll)  ──┐
ProjectXGatewayBroker stream        ──┼─▶  TradingEngine.onNewBar()
                                       │
                                       ├─▶ manage open trades (stop/target/trailing via SimulatedBroker,
                                       │     or the live broker's own bracket orders)
                                       │
                                       ├─▶ classifyRegime()            → regime_history
                                       ├─▶ getNewsRiskStatus()         → news risk window check
                                       ├─▶ Strategy.generateSignal()   → candidate setup
                                       ├─▶ buildSetupFeatures()        → feature vector
                                       ├─▶ evaluateSetup()             → probability + taken/skipped
                                       ├─▶ explainScore()              → plain-English sentence
                                       ├─▶ RiskEngine.assessNewTrade() → sizing + stop/target/trailing
                                       └─▶ executeIfApproved()         → order (unless analysis_only)
                                       │
                                       └─▶ websocket broadcast (dashboard live feed)
```

Every arrow above is a call between independently unit-tested modules -- nothing upstream
of the risk engine can place an order, and nothing downstream of the mode gate in
`execution/engine.ts` can be reached except through it.

## Module map

| Module | Responsibility |
|---|---|
| `src/brokers` | `BrokerClient` interface; `SimulatedBroker` (paper fills + bracket simulation); `ProjectXGatewayBroker` (real Topstep API adapter, REST via fetch + SignalR via @microsoft/signalr) |
| `src/marketData` | Instrument registry, free historical backfill (`bars_daily`, `bars_1m`), live bar polling, application-code bar rollups |
| `src/browserWatch` | Optional: read-only CDP attach to a broker web platform tab, label-based extraction of account/price data (see [docs/BROWSER_WATCH.md](../docs/BROWSER_WATCH.md)) -- an alternative to the ProjectX API for account/price data, never used for order placement |
| `src/analytics` | EV, profit factor, Sharpe/Sortino, max drawdown, volatility -- pure functions over number arrays |
| `src/regime` | ADX/Choppiness/Bollinger/ATR-percentile indicators + the trend×vol regime classifier |
| `src/news` | Free economic calendar ingestion + news risk-window logic |
| `src/scoring` | Feature builder, v1 rule-based scorer, hand-rolled logistic-regression training pipeline, threshold gate |
| `src/risk` | Position sizing, stop/target/trailing-stop rules, circuit breakers |
| `src/strategy` | Pluggable `Strategy` interface + breakout/mean-reversion/trend-following reference strategies |
| `src/execution` | Mode gate (`analysis_only`/`paper`/`live`) + the only code path allowed to call `BrokerClient.placeOrder` |
| `src/explain` | Turns every structured decision into a plain-English sentence |
| `src/engine` | `TradingEngine` -- the orchestration loop tying everything above together |
| `src/api` | Fastify routes + `/ws/live` websocket broadcaster |

## Database

Prisma schema (`backend/prisma/schema.prisma`) against plain Postgres. `bars_1m`,
`regime_history`, `scores`, and `equity_curve` are large/time-series-shaped tables with
composite primary keys on `(time, ...)` and secondary indexes on `(symbol, time)` for range
queries -- the same shape TimescaleDB hypertables would use, just without automatic
partitioning. `bars_daily` covers the 1-year+ historical requirement (see below).

## Why these engineering choices

- **Rule-based scorer, not a black box.** No trade history exists yet to fit a model on; a
  transparent weighted heuristic (`scoring/ruleScorer.ts`) is honest about that and is
  designed to be superseded by `scoring/training.ts`'s calibrated model once enough closed
  trades accumulate.
- **SimulatedBroker owns its own bracket simulation.** A live broker enforces stop/target
  brackets server-side; the simulated broker has to replicate that behavior locally
  (`evaluateBar`/`updateTrailingStop`) so paper trading behaves the same way structurally.
- **Daily bars for the 1-year+ backfill; 5-minute for intraday.** Yahoo's free endpoint
  doesn't serve interval=1m for CME futures continuous contracts at all (equities only) --
  5-minute is the finest granularity available, ~60 trailing days. `bars_1m` (the table name
  is a holdover from the original 1-minute spec) holds this 5-minute intraday data and is the
  live execution resolution; `bars_daily` is the long-horizon analytics resolution.
- **Single static API key, no user system.** Tera Trade runs on one operator's machine; a
  multi-tenant auth system would be unused complexity.
- **Decimal.js everywhere money is involved.** JavaScript's native `number` is a float and
  unsafe for prices/PnL; every price, size, and PnL calculation uses `Decimal` instead.
