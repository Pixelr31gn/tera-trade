# Execution Decision Engine: resting limit orders instead of immediate market orders

The Signal Engine (v1/v2/v3 scoring + majority-vote consensus) already decides **whether** to
trade. The Execution Decision Engine (EDE) decides **where/when/how** to enter once a signal has
cleared consensus and risk approval -- instead of firing an immediate market order at whatever
the current price happens to be, it scores a ladder of nearby prices and works a resting limit
order at the best one, re-scoring every bar until it fills, gets a better/worse setup, or ages
out.

This is new automation, off by default, and has not yet been verified against a real fill on the
live account -- read this whole document, and test with `DRY_RUN_ORDERS=true` first, same as
`BROWSER_CONTROL.md`'s own advice for the market-order path.

## How it works

1. **Fair Value Map** (`execution/fairValueMap.ts`) -- builds a picture of where price "should"
   trade right now from the existing analytics: rolling VWAP, volume profile (POC/VAH/VAL,
   HVN/LVN), Bollinger/Keltner bands, and recent order-flow absorption/delta divergence.
2. **Entry Quality Model** (`execution/entryQualityModel.ts`) -- scores a price ladder around the
   current price against 10 factors (distance to fair value, VWAP/band position, volume-node
   proximity, order-flow absorption, trend alignment, etc.), weighted per the operator's original
   spec. Note the 10 weights sum to ~105, not 100 -- kept exactly as specified rather than
   silently rescaled; see the type comment on `EntryQualityScore.score`.
3. **Execution state machine** (`execution/executionStateMachine.ts`) -- pure
   `waiting -> building_entry -> ready -> resting_order -> filled` transitions, plus:
   - **Time decay**: a setup that's been waiting too long has its score penalized, then cancelled
     past a hard age cap (`computeAgePenalty`).
   - **Opportunity cost**: cancels a still-waiting setup if the market itself moved against the
     original premise (entry score cratered, reward shrank, stop grew, ATR expanded, or trend
     accelerated -- `checkOpportunityCost`). This only applies pre-fill; once a resting order is
     actually out, only the age cap can still cancel it (see below).
4. **Orchestrator** (`execution/executionDecisionEngine.ts`) -- the only place that actually talks
   to the broker for this feature: places the resting limit order once the ladder produces a
   `ready` state, checks `isPositionFlat` each subsequent tick to detect a fill, and cancels the
   resting order if it's been out too long. A `trades` row is only ever created on a **confirmed
   fill** (`isPositionFlat` returning `false`), never at order-placement time -- matches this
   codebase's existing standard that "open" in the database means a real, confirmed position (see
   the 2026-07-19 phantom-position incident in `BUILD_HISTORY.md`).

## Enabling it

There's a dashboard toggle for this: **Settings -> Execution Decision Engine**. It's backed by
`SystemState.executionDecisionEngineEnabled` (a live DB row, same mechanism as the Trading Mode
switch above it) rather than a static env var, so flipping it takes effect immediately, no backend
restart needed. Turning it on from the dashboard asks for confirmation first, same as placing or
closing a real order.

```
EXECUTION_DECISION_ENGINE_ENABLED=true
```

This env var only seeds the DB row's initial value the very first time `system_state` is created
(mirrors how `TRADING_MODE` seeds `SystemState.mode`) -- once that row exists, the dashboard
toggle (or `POST /api/system/execution-decision-engine`) is the live, authoritative value, and the
env var is no longer read.

Also requires `BROKER_KIND=browser_control` (checked via `brokerKindForMode`, not trading mode
directly) -- `SimulatedBroker` doesn't implement `isPositionFlat`/`cancelRestingOrder`, so paper
mode always falls through to the existing immediate-market-order path (`executeIfApproved`)
regardless of this flag. `analysis_only` and `paper` modes both resolve to `BROKER_KIND=simulated`
by construction, so in practice this flag only changes behavior once you're in `live` mode with
`browser_control` -- the same "both must independently opt in" posture as `LIVE_TRADING_CONFIRMED`
and `DRY_RUN_ORDERS`.

`DRY_RUN_ORDERS` applies identically to limit orders as it does to market orders --
`BrowserControlBroker.placeOrder` checks it once, before branching on order type -- so
`DRY_RUN_ORDERS=true` is the safe way to watch the resting-order automation (widget found, order
type switched to Limit, price/quantity filled in) without ever submitting a real order.

## Known limitations

- **Not yet live-verified.** The DOM automation for switching to Limit order type and setting a
  limit price was built and exercised interactively against the real TopstepX order ticket, but
  no end-to-end resting-order placement/fill/cancel has been run for real yet, even under
  `DRY_RUN_ORDERS=true`.
- **Hand-set constants throughout** -- the Entry Quality Model's 10 factor weights, the
  `MIN_ENTRY_QUALITY_THRESHOLD` (70) in `executionDecisionEngine.ts`, the time-decay penalty
  table, and the opportunity-cost thresholds are all set from the operator's spec/judgment, not
  fitted against resolved outcomes. Phase 6 (below) exists to start collecting the data needed to
  eventually recalibrate these; no self-adjusting mechanism exists yet.
- **Learning-system data collection only, not the learning system itself.** Every EDE-filled trade
  now records `entryQualityScore` (the winning ladder score at fill) and `timeToFillSeconds`
  (resting-order placement to confirmed fill) on the `trades` row, alongside the existing `score`
  (signal score, same field the market-order path already populates). Nothing currently reads
  these back to adjust weights -- that requires "hundreds of resolved trades" per the original
  spec, and is intentionally deferred.
- **Fill price is an estimate.** The recorded `entryPrice` on an EDE fill is the configured limit
  price, not a broker-confirmed fill price (`BrowserControlBroker` doesn't yet expose one for a
  resting order) -- flagged directly in the trade's `explanation` text.
- **No automatic detection of a resting order being cancelled from TopstepX's side** (e.g. by the
  platform itself, or manually) -- only this engine's own age-based cancellation is modeled.
