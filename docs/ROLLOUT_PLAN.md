# Phased Rollout Plan

Tera Trade is built so that going from "the code runs" to "real money is at risk" requires
a sequence of deliberate, explicit steps -- never a default or an accident.

## Phase 0 -- Analysis only, simulated everything (current state)

- `TRADING_MODE=analysis_only`, `BROKER_KIND=simulated`.
- Historical backfill from free sources; live "market data" is polled Yahoo Finance bars.
- Regime detection, news risk, strategies, scoring, and risk sizing all run continuously and
  are visible on the dashboard, but **no order is ever placed** -- not even a simulated one.
- Goal: validate that regimes, scores, and explanations look sane against real market
  structure before trusting the system with any kind of execution.

## Phase 1 -- Analysis only, live data

- Prerequisite: a ProjectX Gateway API key from Topstep (`help.topstep.com` → TopstepX API
  Access).
- Set `PROJECTX_USERNAME` / `PROJECTX_API_KEY`; keep `BROKER_KIND=simulated` and
  `TRADING_MODE=analysis_only` for now, but point market data ingestion at
  `ProjectXGatewayBroker.startMarketStream()` instead of the Yahoo poller.
- Goal: confirm the regime/scoring pipeline behaves the same against true real-time data
  (tighter bars, real bid/ask) as it did against polled Yahoo data.

## Phase 2 -- Paper trading

- Set `TRADING_MODE=paper` (via `POST /api/system/mode`, from the Settings page).
  `BROKER_KIND` stays `simulated` -- `SimulatedBroker` now actually executes qualifying
  setups (score >= threshold, risk-approved) with realistic slippage and its own
  stop/target/trailing bracket simulation.
- Every trade is booked, scored, and explained exactly as a live trade would be. Run this
  for long enough to accumulate a statistically meaningful sample (aim for at least the
  `MIN_TRAINING_ROWS` used by `src/scoring/training.ts`, currently 200 closed trades) before
  judging performance or considering Phase 3.
- This is also the point at which `POST /api/backfill/run`'s accumulated data plus paper
  trades can train the first real ML scoring model (`src/scoring/training.ts`'s `trainModel`),
  superseding the v1 rule-based scorer.

## Phase 3 -- Live trading (optional, explicit opt-in only)

Reaching `live` requires **all** of:

1. `BROKER_KIND=projectx` with valid, tested `PROJECTX_USERNAME` / `PROJECTX_API_KEY`.
2. `LIVE_TRADING_CONFIRMED=true` -- a separate flag from `TRADING_MODE`, so a mode change
   alone can never reach live trading.
3. An explicit `POST /api/system/mode {"mode": "live"}` call (the Settings page's Live
   Trading button is disabled until (1) and (2) are satisfied).

Recommended practice before flipping this switch:

- Start with the smallest possible position size (`maxPositionSize: 1` in risk limits, via
  `PATCH /api/accounts/:id/risk-limits`).
- Keep a human in the loop initially -- watch the Recommendations feed and be ready to use
  the kill switch (`POST /api/system/kill-switch/clear` only clears it; tripping it happens
  automatically via the risk engine's circuit breakers).
- Only automate fully once paper-trading performance has been reviewed against the
  Performance page's Sharpe/Sortino/drawdown/profit-factor numbers across enough trades and
  enough different regimes to trust the sample.

## Safety mechanisms active in every phase

- **Mandatory stop-loss.** `src/risk/sizing.ts` sizes a position from its stop distance; no
  stop distance means zero contracts, unconditionally.
- **Circuit breakers** (`src/risk/circuitBreakers.ts`): daily loss limit and trailing
  drawdown limit trip the kill switch account-wide; consecutive-loss and max-daily-trade
  limits pause new entries without a full kill switch.
- **News risk window**: no new entries within `NEWS_RISK_WINDOW_MINUTES` of a high-impact
  economic release.
- **Mode gate**: `src/execution/engine.ts` is the only code path that can call
  `BrokerClient.placeOrder`, and it checks `TradingMode` before doing so.
