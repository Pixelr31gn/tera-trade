# Architecture

## Data flow

```
LiveBarPoller (yfinance poll)  ──┐
ProjectXGatewayBroker stream  ──┼─▶  TradingEngine.on_new_bar()
                                  │
                                  ├─▶ manage open trades (stop/target/trailing via SimulatedBroker,
                                  │     or the live broker's own bracket orders)
                                  │
                                  ├─▶ classify_regime()            → regime_history
                                  ├─▶ get_news_risk_status()       → news risk window check
                                  ├─▶ Strategy.generate_signal()   → candidate setup
                                  ├─▶ build_setup_features()       → feature vector
                                  ├─▶ evaluate_setup()             → probability + taken/skipped
                                  ├─▶ explain_score()              → plain-English sentence
                                  ├─▶ RiskEngine.assess_new_trade()→ sizing + stop/target/trailing
                                  └─▶ execute_if_approved()        → order (unless analysis_only)
                                  │
                                  └─▶ websocket broadcast (dashboard live feed)
```

Every arrow above is a call between independently unit-tested modules -- nothing upstream
of the risk engine can place an order, and nothing downstream of the mode gate in
`app/execution/engine.py` can be reached except through it.

## Module map

| Module | Responsibility |
|---|---|
| `app/brokers` | `BrokerClient` interface; `SimulatedBroker` (paper fills + bracket simulation); `ProjectXGatewayBroker` (real Topstep API adapter) |
| `app/market_data` | Instrument registry, free historical backfill (`bars_daily`, `bars_1m`), live bar polling |
| `app/analytics` | EV, profit factor, Sharpe/Sortino, max drawdown, volatility -- pure functions over pandas |
| `app/regime` | ADX/Choppiness/Bollinger/ATR-percentile indicators + the trend×vol regime classifier |
| `app/news` | Free economic calendar ingestion + news risk-window logic |
| `app/scoring` | Feature builder, v1 rule-based scorer, offline ML training pipeline, threshold gate |
| `app/risk` | Position sizing, stop/target/trailing-stop rules, circuit breakers |
| `app/strategy` | Pluggable `Strategy` interface + breakout/mean-reversion/trend-following reference strategies |
| `app/execution` | Mode gate (`analysis_only`/`paper`/`live`) + the only code path allowed to call `BrokerClient.place_order` |
| `app/explain` | Turns every structured decision into a plain-English sentence |
| `app/engine` | `TradingEngine` -- the orchestration loop tying everything above together |
| `app/api` | FastAPI routers + `/ws/live` websocket broadcaster |

## Database

TimescaleDB hypertables (`bars_1m`, `regime_history`, `scores`, `equity_curve`) with
continuous aggregates (`bars_5m/15m/1h/1d`) rolling up from `bars_1m`. `bars_daily` is a
plain (non-hyper) table used for long-horizon (1+ year) analytics that free 1-minute data
can't cover. See `backend/app/db/models.py` and `backend/alembic/versions/0001_initial_schema.py`.

## Why these engineering choices

- **Rule-based scorer, not a black box.** No trade history exists yet to fit a model on; a
  transparent weighted heuristic (`app/scoring/rule_scorer.py`) is honest about that and is
  designed to be superseded by `app/scoring/training.py`'s calibrated model once enough
  closed trades accumulate.
- **HistGradientBoostingClassifier over LightGBM.** Equivalent model family, no native
  build step, avoids Windows wheel friction for a dataset this size.
- **SimulatedBroker owns its own bracket simulation.** A live broker enforces stop/target
  brackets server-side; the simulated broker has to replicate that behavior locally
  (`evaluate_bar`/`update_trailing_stop`) so paper trading behaves the same way structurally.
- **Daily bars for the 1-year+ backfill.** Yahoo Finance only serves 1-minute history for
  ~7 trailing days for free; daily bars go back years. `bars_1m` is the live execution
  resolution, `bars_daily` is the long-horizon analytics resolution.
- **Single static API key, no user system.** Terra Trade runs on one operator's machine
  (Docker Desktop); a multi-tenant auth system would be unused complexity.
