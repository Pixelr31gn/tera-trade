# Tera Trade — Build History & Current Architecture

This document is the "how we got here" narrative for the whole project, plus a current
snapshot of how the system actually works. `ARCHITECTURE.md` describes the original Phase 0
design decisions (Node vs Python, database choice) and is now partially superseded by this
doc in the areas noted below; `BROWSER_WATCH.md` and `BROWSER_CONTROL.md` remain the accurate
deep-dives on those two subsystems specifically.

## What Tera Trade is

An algorithmic trading platform for Topstep-funded futures accounts (ES/NQ/CL/GC, traded as
their micro equivalents MES/MNQ/MCL/MGC), built to run against the user's real TopstepX
account. It watches price and account data, scores candidate setups with a rule-based
strategy engine, sizes and manages risk on every trade, and can either surface recommendations
for manual execution or place/manage trades itself — gated behind explicit mode switches so
nothing trades for real until deliberately turned on. As of v1.2, running live against a real, funded
TopstepX account (`BrowserControlBroker`) alongside paper mode's validation runs.

## Timeline

### Phase 0 — Scaffold (2026-07-04)
Built first as a Python/FastAPI + SQLAlchemy + TimescaleDB stack (`e91d70a`) with the full
module set planned from the start: broker abstraction, market data ingestion, analytics
(EV/profit factor/Sharpe/Sortino/drawdown/MAE/MFE), regime detection, news-calendar risk
windows, a rule-based scorer with an offline ML training pipeline, a risk engine, reference
strategies, a mode-gated execution engine, a plain-English explanation engine, and a Next.js
dashboard. Locked to `analysis_only` mode from the first commit — no order placement anywhere
until explicitly unlocked.

Neither Python nor Docker were actually installable on the target machine, so the same day the
backend was **rewritten in Node.js/TypeScript against Fastify + Prisma + Neon** (hosted
Postgres, no Docker needed) — same module boundaries, database shape, and API contracts, just a
different runtime (`0a51b9b`).

### Getting real data flowing (2026-07-04 – 2026-07-05)
- Yahoo Finance's free chart endpoint turned out not to serve 1-minute bars for CME futures at
  all (equities only), and failed silently instead of erroring — fixed to fail soft and fall
  back to 5-minute bars, the actual free floor (`2ed07a0`).
- Added a **read-only browser-attach data source** (`4fd7ea0`, calibrated in `ed18d71`,
  `84a179d`): rather than wait on ProjectX Gateway API credentials, Tera Trade attaches over
  Chrome DevTools Protocol to a TopstepX tab already open and logged into in the user's own
  Chrome, and reads account balance/P&L and live prices directly off the rendered page. Nothing
  in this path can click, type, or submit anything — pure observation. This became, and remains,
  the system's primary live data source (see `BROWSER_WATCH.md`).
- Renamed Terra Trade → **Tera Trade** (`60b0446`), cosmetic only.

### Manual-execution phase (2026-07-05)
Before any automated order placement existed, the system worked as a recommendation engine for
a human trading manually on TopstepX:
- Actionable trade-call banner (`ce347af`) surfacing the most recent live "taken" setup with a
  freshness classifier (fresh/stale/expired).
- Entry/stop/target prices shown on every call (`5ed9c5a`).
- Opening-range breakout statistics (`742bf2d`, `7e5239f`) — real empirical probability of a
  session's first-hour high/low being broken later, computed from actual historical bars, with
  an explicit sample-size confidence tier rather than a hand-tuned number.
- Per-session (NY/London/Asian) trade data collection and **retrospective outcome tracking**
  (`7ead3a0`): every scored setup, taken or skipped, gets simulated forward through subsequent
  bars and labeled win/loss, so skipped opportunities feed the training data too, and the ML
  pipeline trains one model per session instead of one universal model.
- Daily-trend weighting (`2405f8a`) to stop the intraday regime classifier whipsawing
  long/short/long as short-term noise passed through — a heavily-weighted factor now penalizes
  any setup fighting a confident *daily* trend, computed off ~1yr of daily bars.

### Real order placement (2026-07-06)
- **`BrowserControlBroker`** (`5b695d4`): real order placement via mouse/click automation over
  the same CDP connection, since no ProjectX API key existed. Every selector and interaction
  (contract matching, quantity, the $ risk/profit bracket panel, violation-modal handling) was
  calibrated against the live account, not guessed. Going live requires four independent
  opt-ins (`TRADING_MODE=live`, `BROKER_KIND=browser_control`, `LIVE_TRADING_CONFIRMED=true`,
  `DRY_RUN_ORDERS=false`) — with dry-run on, the bracket is set for real but the final
  Buy/Sell/Close click is only highlighted, never submitted. Switched tracked instruments to
  the actual micro contracts (MES/MNQ/MCL/MGC) the account trades.
- Gated long entries on a **real, continuously-measured win-rate check** (`259944f`) rather
  than a hand-tuned score threshold: a 20-point long target was checked against actual
  historical data and came back nowhere near a usable win rate (best case ~16%), so longs are
  only taken once real evidence clears a 67% bar — an honest "mostly blocked right now" state
  that unlocks automatically as real data accumulates.

### Dashboard redesign and fixed-dollar risk (2026-07-09)
- Consolidated into a single command-center Overview page with a **Quick Order Panel**
  (`9a0096e`) — live entry/$risk/$profit/R:R preview, manual order placement reusing the same
  circuit breakers and mandatory-stop rule as automated entries.
- MA(8/20/200) trend stack + Fibonacci retracement/extension levels (`cc00701`) as manual
  decision-support reference in the Quick Order Panel (not a scoring signal).
- **Fixed-dollar risk overrides** (`06da9ce`): position sizing and profit targets moved from
  percentage-of-equity to a fixed dollar budget per trade, so risk stays constant instead of
  drifting with equity — later found to have a subtle interaction bug with `maxPositionSize`
  caps (see "Fixing the win rate" below).
- Fixed the recommendation feed showing stop/target from an entirely different, stale risk
  calculation than what real trades actually used (`ee459b2`) — extracted a shared
  `risk/tradePlan.ts` so the dashboard always shows the exact plan a real trade would execute.
- **v1/v2 shadow-scoring** (`92beffe`): every signal now scored under both strategy versions in
  parallel against identical bars, each persisted as its own tagged row, so performance stays
  directly comparable. Only the active version's decisions reach execution; the other keeps
  accumulating comparison data for free. v2 added factors informed by real session-performance
  data (market-structure and liquidity edges) that v1's coarser scoring missed.
- Fixed a Playwright dialog race that was silently crashing the entire backend process
  (`0c74e4f`) — an uncaught error thrown from inside Playwright's own internal event handling,
  unreachable by any try/catch. Added an explicit dialog handler plus process-level
  uncaught-exception survival (a crashed backend means zero risk oversight, which is worse than
  surviving a narrow, non-critical error).

### Most recent session — diagnosing and fixing the 18.97% win rate

This is the work not yet committed to git as of this document. Starting point: real trading
had settled at an **18.97% win rate**, and the user asked for the root cause.

**v3 scoring** was added alongside v1/v2 (`scoring/ruleScorerV3.ts`,
`scoring/v3HistoricalAdjustment.ts`) incorporating several new signal sources built this
session: order-flow (`browserWatch/orderFlowListener.ts` — raw WebSocket trade-aggressor/order-
book data, not the DOM ladder widget, currently observational only pending accuracy
validation), a support/resistance pivot detector (`analytics/supportResistance.ts` — fractal
highs/lows clustered by ATR-based tolerance with touch-count strength), VWAP, RSI, and EMA
trend analytics. A **v1/v2 → v3 override** was added (`scoring/gate.ts`): if v1 and v2
independently agree "taken," v3 is force-overridden to "taken" too regardless of its own score,
with the override explained transparently rather than fabricating v3's own probability.

**Root cause found**: `bars_1m` was storing one row per raw price tick (~every 5-10s from the
browser watcher) with `open = high = low = close` on every row — a zero-range degenerate "bar."
Every downstream consumer treating "the last 20 bars" as 20 minutes was actually looking at
100-200 seconds of tick noise: ATR was near-zero, Donchian breakout signals fired on meaningless
tick-level wiggles, and support/resistance pivots were detected from noise. Confirmed
concretely: real trade data showed a **25.2-second median holding time** (max ~5 minutes), and
**100% of 58 closed trades exited via stop** — zero ever reached take-profit.

Fixed with a new `marketData/minuteBarAggregator.ts`: aggregates raw ticks into genuine
in-memory 1-minute OHLCV bars per symbol, only persisting/signaling a bar once a real minute has
elapsed. `engine/loop.ts`'s `onNewBar` was split into `onPriceTick` (fast path, every tick —
stop/target monitoring and live equity, unchanged responsiveness) and `onNewBar` (slow path,
only on a genuinely completed bar — strategy signal generation). Verified live after the fix:
real OHLC ranges (not zero-range), bars landing on exact 60-second boundaries, strategy
evaluation firing exactly once per completed minute, and the first trade under the fixed
pipeline held 35+ minutes and won (vs. the prior ~25-second median).

**Risk:reward floor, then a better fix.** Initially added a floor in `risk/tradePlan.ts`
(`MIN_RISK_REWARD_DENOMINATOR = 3`) that widened the stop whenever a fixed-dollar profit target
implied risking less than 1/3 of the target. This masked a deeper issue: with
`maxPositionSize` capped at 3 contracts (a real Topstep account rule) and a fixed-dollar
`perTradeProfitDollars` target, a genuinely tight, structurally-correct stop (e.g. 2 points)
couldn't deploy the full risk budget through contract count alone — the code was compensating
by stretching the stop out to an arbitrary ~4-5 points instead, and the fixed-dollar target
was floating the actual point-distance around ~13 points regardless of the real stop distance.
Fixed properly by decoupling the target from dollars entirely: cleared `perTradeProfitDollars`
on the active accounts and changed the default take-profit multiple
(`risk/stops.ts`) from 2.0x to **3.0x the actual stop distance, in points** — a true "2-point
risk, 6-point reward" structure that scales correctly per instrument (verified live: ES
3.91pt/11.74pt, NQ 25.10pt/75.30pt, GC 3.90pt/11.71pt — all exactly 3.00x).

**Consensus rule for paper trading** (`engine/loop.ts`'s `determinePaperConsensus`): paper mode
executes a signal only if all three strategy versions agree "taken," or at least two of three
agree with both scoring ≥70% — a stricter bar than any single version's own threshold, since
paper mode is specifically for validating quality before live use.

**Breakout signals were being gated by the wrong kind of level.** The universal support/
resistance proximity gate (`risk/engine.ts`) required a long to enter near **support** and a
short to enter near **resistance** — correct for a bounce/reversal trade, but backwards for
`breakout_donchian_20`: a short breakout means price just broke *below support*, and the gate
should validate against *that broken support*, not search for some unrelated nearby resistance
pivot. Concrete evidence from the live log: a real short breakout on ES fired repeatedly (v1,
v2, and v3 all agreed, 68-97% confidence) but was rejected every time, and the rejection got
*worse* as the move strengthened — `1.00x ATR → 2.05x ATR → 3.88x ATR from the nearest
resistance level (7578.00, 1 touches)` — because the gate had latched onto an unrelated,
single-touch pivot instead of the level actually being broken, and that irrelevant pivot got
more distant as the breakout ran further in its own favor. Also exposed: the gate accepted a
level formed from a single untested pivot as valid support/resistance, when a real level (the
kind price has actually rejected from before) requires being touched more than once.

Fixed by adding `Signal.signalKind` ("breakout" vs "reversal") and `Signal.breakoutLevelPrice`
(the actual prior high/low the breakout strategy detected it broke). The risk engine now
validates breakout signals against that specific level — matched via
`findLevelNearBreakout` — requiring it to have been touched at least twice
(`MIN_LEVEL_TOUCHES`) to count as a real, previously-respected zone, rather than re-searching
for "the nearest same-direction level to current price." Mean-reversion and trend-following
signals are unaffected (tagged `"reversal"`, keep the original bounce-style gate, now also
subject to the same 2-touch minimum). Verified with new tests in `tests/riskEngine.test.ts`
covering both the breakout-approval and single-touch-rejection paths; full suite (191/192)
passing.

**Order flow wired into v3 scoring** (`analytics/orderFlow.ts`): a bounded
+/-8pt v3-only adjustment (same pattern as the fib/PPM adjustments above),
combining trade-aggressor buy/sell volume from the live listener's most
recent flush window (weighted 0.7) with resting best-bid/best-ask size
(weighted 0.3) into a single directional read, gated on at least 3 trades in
the window so a lone print can't flip the imbalance to +/-1. TopstepX's own
crowd long/short "Tilt" bias is captured on every snapshot but deliberately
left out of the score itself -- whether crowd positioning should be followed
or faded isn't established for this account, and guessing the sign would
actively mislead scoring rather than just add noise. `SetupFeatures` now
carries the full `OrderFlowSnapshot` (`features.orderFlowSnapshot`) so it's
persisted with every Score row for later analysis. v1/v2 are unaffected --
this is v3-only, consistent with fib/PPM/risk-reward already being v3-only
bounded adjustments rather than core factors.

**Remote access**: set up Tailscale (private mesh VPN) after confirming the home connection
sits behind T-Mobile CGNAT (no real public IP to port-forward from) — reaches the dashboard
from another device without exposing the trading API to the public internet, which would be a
real risk given a single static API key is the only thing gating order placement and kill-switch
control.

### Performance pass, position-sizing floor, and a majority-vote consensus rule (2026-07-16)

**Performance**: fixed the likeliest cause of the known ~45-minute OOM crash — the
5-minute outcome-evaluation timer had no overlap guard (unlike its sibling
`runContinuousScan`), so an overrunning pass could pile up concurrently; added the same
`outcomeEvaluationRunning` guard, bounded each pass to 200 rows, and parallelized
`outcomeEvaluator.ts`'s per-row loop with the same bounded-concurrency pattern already
proven in `fixedTargetEdgeCache.ts`. Also fixed `computeAccountEquity` (`engine/
accounting.ts`) re-summing every closed trade the account has ever had, in JS, on every
single price tick — replaced with a Postgres `aggregate`/`SUM`, plus new indexes on
`Score(outcomeLabel, tradeId)` and `Trade(accountId, status, brokerKind)`. Frontend: the
whole dashboard was re-rendering on every websocket tick because `useLiveEvents` lived in
the page component itself — extracted into its own `LiveFeed` component, added
`React.memo`/`useMemo` around the tick-adjacent widgets, and replaced blocking
`confirm()`/`alert()` (order placement, position close, strategy-version switch) with a
proper `ConfirmDialog`. Also found and killed two duplicate backend `tsx watch` processes
that had been running simultaneously for hours, racing for port 8000 on every file save.

**Position-sizing floor-to-zero bug** (operator report: real `breakout_donchian_20`
signals scoring well above threshold were showing "taken, not executed"): `risk/
sizing.ts` derived contract count from a fixed `perTradeRiskDollars` ($50) budget and
floored to **0 contracts** whenever a stop distance made even 1 contract cost more than
$50 — on MNQ ($2/point), any stop past 25 points already did this, and NQ's real
ATR/structure-based stops routinely run past that. Fixed by flooring at a minimum of 1
contract whenever there's a genuinely valid stop (`Math.max(1, ...)` in
`computePositionSize`) — the dollar amount now floats above the nominal budget rather
than vetoing a structure-validated, score-cleared setup down to zero; `maxPositionSize`
and the account-level circuit breakers (daily loss, trailing drawdown, consecutive
losses) remain the real portfolio-level risk controls. Paper account `startingBalance`
also reset to $2,000 (from $50,000) per operator request, to use as a clean baseline for
judging whether the system is net-profitable going forward — live mode is unaffected
(it reads the real scraped Topstep balance regardless of this field).

**Consensus rule replaced with a straight majority vote**: the previous rule (2026-07-14,
"average of v1/v2/v3 clears 61%, or v3 alone clears its own 65%") let one strongly-
disagreeing version veto a setup the other two independently liked — a real example: v1
scored a short 72%, v3 scored it 65% (both individually clearing 65%), but v2's 43%
dragged the three-way average to 60%, just under 61%, and v3 didn't clear its own
threshold on its own that time either, so the trade was skipped despite 2 of 3 models
being confident. Replaced `determineConsensus` (`engine/loop.ts`) with: **take the trade
if at least 2 of the 3 versions individually clear the 65% score threshold**, full stop —
applies to both paper and live.

### v1.2 — Pattern-mined scoring, live-incident hardening, per-account equity, and a themed UI (2026-07-21 – 2026-07-22)

**v5, the first scoring version built from mined data rather than intuition**: added a
documented pattern-mining methodology to a new `add-scoring-version` skill, then ran it against
real resolved outcomes (`executed_win`/`executed_loss`/`missed_win`/`missed_loss`, ~36k+ scores).
Found three real, asymmetric patterns — ADX-regime asymmetry (a very strong trend, ADX≥40, favors
shorts and hurts longs), weak-trend fade (fading a weak trend beat following it, both sides), and
price-action normalcy (a "normal" candle outperformed every dramatic shape). Built into
`ruleScorerV5.ts` as a weighted-logit scorer and wired in as **shadow-only**
(`SHADOW_ONLY_VERSIONS` in `engine/loop.ts`) — scored on every signal, visible everywhere v1/v2/v3
are, but deliberately excluded from `STRATEGY_VERSIONS` so it can never affect consensus or a real
trade until it's earned promotion on its own live track record.

**Corrupted-bar incident and the fixes it drove**: a live price-extraction outage produced a
single degenerate 1-minute bar (ES read as 2.30 against a real ~7549) that fed a continuous-scan
entry a nonsensical ATR-derived stop/target; the resulting bracket order was rejected outright by
TopstepX (invalid price levels), leaving the position briefly unprotected until `manageLiveOpenTrade`'s
own stop-crossed check forced a close a few seconds later (net real loss: -$1.25). Root-caused to
`minuteBarAggregator.ts`'s implausible-move guard, which had a rejection-timeout escape hatch that
accepted the *first* post-timeout outlier tick with zero corroboration. Fixed to require 3
consecutive matching ticks before trusting a big price move as real. A second, related gap found
the same night: even a single bad bar that self-heals immediately still poisons Wilder's-smoothed
ATR (and everything downstream — stops, targets, v3's volatility factor) for many minutes after,
since the smoothing only decays ~7%/bar. Fixed at the source (`regime/indicators.ts`'s
`trueRange()`) by clipping any single bar's true range to at most 10x the trailing local median
before it ever reaches ATR/ADX/choppiness calculations.

**Per-account equity-curve separation**: the account switcher on TopstepX (three real funded
accounts observed: an Express account and two DLL Combines) was never tracked at all — every
equity point landed on one shared internal account row regardless of which real account was
selected, silently blending all three histories into one curve. Added
`extractActiveAccountIdentity` (reads the account-switcher's `<name>|<real ID>` text off the
page), `ensureAccountForBrokerId` (get-or-create an `Account` row per real `brokerAccountId`,
using the schema's previously-unused field), and a dashboard account picker defaulting to
whichever account is live right now. Starting balance is inferred from the account name (Express
tiers start at $0; Combine tiers start at their full size) rather than a flat $50k default —
deliberately scoped to equity-curve display only; trades and risk-limit/circuit-breaker tracking
still use the single shared account row (an operator call, not an oversight — see Known
limitations).

**S/R proximity gate retuned live**: `MAX_ENTRY_DISTANCE_ATR` (`risk/engine.ts`) raised 1.25 →
1.9 after a sustained strong-trend session (ADX 44-47) blocked nearly every continuous-scan
signal on both ES and NQ, several scoring 90%+ across all versions, for running too far from the
last real S/R pivot.

**"Snow leopard" UI theme**: retint of the whole dashboard's Tailwind color tokens (cool
granite/slate darks, an icy glacier-blue accent replacing the prior saturated blue), a faint
scattered-texture background nodding at the coat's rosette pattern, a glowing paw-print nav mark,
and a matching glow treatment on the equity curve chart. `good`/`bad`/`warn` semantic colors were
deliberately left untouched — this is a live-money dashboard, and win/loss/caution clarity took
priority over full-theme consistency.

**Phantom-trade incidents (open — not yet fixed)**: multiple real occurrences this session (5
trades total) of a Trade row recorded as `status: open` with no corresponding real position on
the actual TopstepX account. Traced to `execution/engine.ts` / `browserControlBroker.placeOrder()`
treating a successful Buy/Sell button click as an immediate, confirmed fill, with no verification
step afterward — a silent broker-side rejection (a lockout, a margin check, anything that doesn't
throw a Playwright exception) still produces a permanent phantom "open" trade. Each occurrence was
reconciled (closed out, exit data left null rather than fabricated) via a new `clear-pos` skill,
but the underlying fix — verify via `isPositionFlat` that a real position actually appeared before
creating the Trade row — has been scoped and proposed but not yet implemented; see Known
limitations.

**New operator skills** (`.claude/skills/`, not part of the shipped app):
`diagnose-signal` (trace why a specific Recommendation Feed row did or didn't execute),
`browser-automation-dev` (safely write/test new Playwright automation against the live page),
`reconcile-trade` (fix the trades table when it disagrees with the real account — phantom/missed/
undetected-close shapes), `add-scoring-version` (now includes the pattern-mining methodology
above), `tune-risk-constant` (safely retune a hand-set risk/scoring constant from live evidence),
and `clear-pos` (fast-path phantom-position cleanup once the operator's confirmed it directly on
TopstepX).

**Chrome page-detection hardening + price-corruption incidents (2026-07-28)**: two real corrupted-
price incidents this session, both traced to `browserWatch/cdpClient.ts`'s `findPage` selecting the
wrong tab. First: a logged-out `/login` tab still matched the "topstepx.com" URL check, so price
extraction quietly scraped login-page text as if it were a quote. Fixed by requiring `/trade` in
the URL — but the very next fresh debug-Chrome auto-launch (`chromeLauncher.ts`) landed on the bare
`topstepx.com/` root (mid client-side-redirect), which the `/trade` requirement rejected even
though the page was, in a separately-confirmed case, a *fully authenticated* session that never
updates its URL path at all. URL path turned out to be an unreliable signal for this app either
way. Final fix: `findPage` now checks page *content* for the account-balance panel (`extractAccountSnapshot`'s
existing `"bal:"` marker) to confirm authentication, independent of URL. Separately, a stray
`MNQU26` mention in TopstepX's closed-trade-history table (a different panel than the live quote
table) let `extractPriceForSymbol`'s un-anchored decimal regex pull a timestamp fragment
(`16:01:00.991` → `0.991`) out as a fake price — fixed by anchoring the price regex to the whole
line and recognizing the Micro-contract `M` prefix as a proper contract-code match. ~2,700
historical corrupted `bars_1m` rows (from this and earlier incidents going back to 2026-07-10) were
found still sitting inside the ATR lookback window, inflating ES's ATR to 623 (should be ~2-10) —
deleted after confirming each was outside any sane price range for its symbol.

**Stale-data trading gap fixed**: `scanSymbolContinuously` (`engine/loop.ts`) is timer-driven, not
tick-driven — it re-reads the DB every ~15s regardless of whether new price data has arrived, and
its only protection against re-scoring the same bar twice was an in-memory map that resets on every
process restart. With the price feed dead for ~17 hours (Chrome stuck off the trade view) and
several routine backend restarts in between, a restart reset that map and made the same 17-hour-old
bar look "new" again, opening a real (paper-mode, no real money) trade off stale data. Fixed with an
absolute staleness check: any bar older than 5 minutes is rejected outright, independent of restart
timing.

**Consecutive-loss circuit breaker now resets daily**: previously computed from the last 50 closed
trades with no time bound, which meant a losing streak could permanently wedge the account — the
breaker blocks all new entries, and only a win clears it, but a win requires a new entry. Scoped to
UTC-day-boundary, matching how `tradesToday`/daily-loss-% already work.

**S/R ATR-distance gate removed entirely**: `MAX_ENTRY_DISTANCE_ATR`/`MIN_ENTRY_DISTANCE_ATR`
(`risk/engine.ts`) — reactively loosened four times (1.0 → 1.25 → 1.9 → 3.0, then a 1.25 floor
added) over the life of this project with no backtested basis behind any of the specific bounds,
and it played no role in stop/target pricing for continuous-scan signals (computed independently
from ATR) — it only ever decided approve/reject, duplicating risk-shaping the scoring models
already do via weighted factors. Operator request, after discussing that a hard proximity gate is a
blunter instrument than letting the scoring models weigh it. The S/R *validation* requirement (a
real, previously-tested 2+ touch level must exist nearby at all) is unchanged.

**S/R ATR-distance gate reinstated, then retuned (2026-07-29)**: same day, operator asked for it
back — restored at the same 1.25x-3.0x band, then retuned to **0.25x-1.95x** the same session.

**Consensus rule unified into a single "mutual agreement" requirement (2026-07-29)**: previously
two different shapes — real-strategy signals needed a plain 2-of-3 majority at the 65%
`minScoreThreshold` (`determineConsensus`), continuous-scan signals needed just one standout
version at 70% plus a 30% floor on the other two (`determineContinuousScanConsensus`), so a single
strong continuous-scan version could effectively drive a trade with the other two barely
tolerating it. Operator request: "v1/2/3 need each other, none should execute on its own." Both
functions now share one rule (`hasMutualAgreement` in `engine/loop.ts`): **at least 2 of the 3
versions must independently clear 75%, and the remaining (weakest) one must clear at least 56%.**

**Tera Trade 1.4 — compiled `.exe` deliverable**: a real, double-clickable Windows distribution
alongside the existing source-zip (`scripts/package.ps1`, still used for v1.1-v1.3-style
distribution). Two packaging approaches were tried and confirmed dead ends before landing on what
works, worth recording so it isn't retried:
- **`pkg`** (Vercel's tool): its only available Windows Node18 prebuilt binary is 18.5.0, which
  predates a `node:diagnostics_channel` API fastify 5 requires (`tracingChannel`) — crashes on
  startup with `TypeError: undefined is not a function`. No Node20 prebuilt exists in `pkg`'s cache
  to fall back to (`pkg -t node20-win-x64` → "No available node version satisfies 'node20'").
- **Node's built-in Single Executable Application (SEA) feature**, fully embedding the bundled app:
  SEA's embedded-script `require()` can resolve Node built-ins only — never an external file, not
  even by absolute path. Both Prisma's native query-engine loader and Playwright-core's own
  internals (e.g. reading their own `package.json` for a version string) do exactly this kind of
  dynamic file-based `require()` internally, unavoidably, crashing the instant either runs
  (`ERR_UNKNOWN_BUILTIN_MODULE`).

**What actually works**: a hybrid. The backend ships as a *tiny* SEA-compiled launcher exe
(`backend/scripts/launcher.cjs`, using only `child_process`/`path` builtins — nothing SEA can't
handle) that spawns a completely ordinary, separate `node.exe` process against a portable,
*unmodified* `app/` folder (real `dist/` + real `node_modules/`, copied wholesale) — Prisma and
Playwright run exactly as they do outside packaging, since neither is ever SEA-embedded. The
frontend, by contrast, ships as a genuinely single-file SEA exe: its static file server
(`frontend/serve.cjs`) is deliberately dependency-free (only Node builtins, serving the
`next.config.mjs` `output: "export"` static bundle via plain `fs` reads, which aren't subject to
SEA's `require()` restriction at all). `scripts/build-exe.ps1` orchestrates the whole pipeline;
`env.ts`/`scoring/training.ts` gained `node:sea`-aware path resolution (`isSea()`) as part of this,
falling back to their original behavior unchanged outside packaging. Postgres and Chrome remain
external in both cases, same as every other Tera Trade distribution.

## Current architecture

### Module map (`backend/src/`)

| Module | Responsibility |
|---|---|
| `brokers/` | `BrokerClient` interface; `SimulatedBroker` (paper fills); `BrowserControlBroker` (real order placement via CDP click automation); `ProjectXGatewayBroker` (built to spec, unused pending API credentials) |
| `marketData/` | Instrument registry, historical backfill, live bar polling, `MinuteBarAggregator` (tick → real 1-minute OHLCV) |
| `browserWatch/` | Read-only CDP attach: account/price extraction (`watcher.ts`) and order-flow WebSocket listener (`orderFlowListener.ts`) |
| `browserControl/` | Order-ticket automation primitives used by `BrowserControlBroker` |
| `analytics/` | EV/profit factor/Sharpe/Sortino/drawdown/MAE/MFE, opening-range stats, moving averages, Fibonacci levels, EMA trend, RSI, VWAP, support/resistance pivot detection — pure functions over bar arrays |
| `regime/` | ADX/Choppiness/Bollinger/ATR-percentile trend×vol regime classifier |
| `news/` | Economic calendar ingestion + news risk-window logic |
| `scoring/` | Feature builder, v1/v2/v3 rule-based scorers, v1↔v2→v3 override logic, threshold gate, logistic-regression training pipeline |
| `risk/` | `tradePlan.ts` (shared stop/target/sizing, used by both real execution and dashboard previews), `sizing.ts` (fixed-fractional position sizing), `stops.ts` (ATR/structure stop, point-based take-profit), circuit breakers |
| `strategy/` | Pluggable `Strategy` interface + breakout/mean-reversion/trend-following reference strategies |
| `execution/` | Mode gate (`analysis_only`/`paper`/`live`) — the only path allowed to call `BrokerClient.placeOrder` |
| `explain/` | Structured decision → plain-English sentence |
| `engine/` | `TradingEngine` orchestration loop, plus per-feature caches (opening range, daily trend, fixed-target edge, trend levels, PPM, order flow, support/resistance) |
| `api/` | Fastify routes + `/ws/live` websocket broadcaster |

### Data flow

```
BrowserWatcher (CDP tick, ~5-10s)
      │
      ├─▶ TradingEngine.onPriceTick()   every tick: manage open trades (stop/target),
      │                                  live equity tracking, kill-switch check
      │
      └─▶ MinuteBarAggregator.addTick() only on a completed real minute:
                  │
                  ▼
            persist bars_1m ──▶ TradingEngine.onNewBar()
                                       │
                                       ├─▶ classifyRegime()              → regime_history
                                       ├─▶ getNewsRiskStatus()           → news risk window
                                       ├─▶ Strategy.generateSignal()     → candidate setup
                                       ├─▶ buildSetupFeatures()          → feature vector
                                       ├─▶ evaluateSetup() × v1/v2/v3    → probability + decision (shadow-scored in parallel)
                                       ├─▶ explainScore()                → plain-English sentence
                                       ├─▶ RiskEngine.assessNewTrade()   → S/R gate, sizing, stop/target (risk/tradePlan.ts)
                                       ├─▶ determinePaperConsensus()     → paper-mode cross-version execution gate
                                       └─▶ executeIfApproved()           → order, only via the active broker and only outside analysis_only
                                       │
                                       └─▶ websocket broadcast → dashboard
```

### Execution modes

`SystemState.mode` gates everything: `analysis_only` places no order anywhere (not even
simulated); `paper` runs through `SimulatedBroker` with the cross-version consensus rule above;
`live` requires `BrowserControlBroker` configured, `LIVE_TRADING_CONFIRMED=true`, and
`DRY_RUN_ORDERS=false` — never auto-escalates. As of v1.2, running in `live` mode against a real
funded account.

### Database (Prisma / local Postgres via Docker)

`Instrument`, `Bar`, `BarRollup`, `DailyBar`, `Account`, `RiskLimit`, `SystemState`,
`RegimeSnapshot`, `NewsEvent`, `Score`, `Trade`, `OrderRecord`, `PositionRecord`,
`EquityCurvePoint`, `OrderFlowSnapshot`. Two `Account` rows carry real trade/risk-limit history —
`default` (id=1, live real-money trades) and `paper` (the simulated-broker validation account),
each with its own `RiskLimit` row so risk budgets don't leak between them. As of v1.2, one
additional `Account` row exists per real TopstepX account the browser watcher has observed
(keyed by the real `brokerAccountId`, see the v1.2 timeline entry) — these carry equity-curve
history only, deliberately not their own `RiskLimit` row, since trades/risk tracking still all
route through the single shared `default` row above.

**Moved off Neon to a local Postgres container** (2026-07-17, operator request — easier
backups/resets, no cloud dependency): `docker-compose.yml` at repo root runs `postgres:18`
(matched to Neon's actual server version — a `postgres:16` client refuses to `pg_dump` a newer
server) on a named volume, port 5432, credentials in the repo-root `.env`
(`POSTGRES_PASSWORD`, gitignored). Migrated via `prisma migrate deploy` against the empty local
DB (recreates schema from migration history) followed by a data-only
`pg_dump --disable-triggers | psql` pipeline run through the container's own client tools
(`docker exec teratrade-postgres sh -c '...'`) since the host had no local `psql`/`pg_dump`.
The Neon database itself was left untouched as a cold backup, not deleted.
`backend/.env`'s `DATABASE_URL` now points at `localhost:5432`. Note for postgres:18
specifically: the official image changed its volume convention to expect a mount at
`/var/lib/postgresql` (not `/var/lib/postgresql/data` as in an internal 18+ subdirectory) —
mounting at the old path fails the container's healthcheck with a clear error.

## Known limitations / open items

- ~~`execution/engine.ts` / `browserControlBroker.placeOrder()` treat a successful order-entry
  button click as an immediately-confirmed fill~~ **Fixed (v1.3.1)**: `placeOrder`'s market-order
  path now polls `isPositionFlat` (up to 4 attempts, 750ms apart) after a successful click before
  ever reporting `status: "filled"` — a persistent "still flat" or unresolvable result is now
  treated the same as a broker rejection, so `execution/engine.ts` never creates a Trade row for
  it (no changes needed there at all — the fix is entirely at the source). Occurred 6 times in
  one session (trades 185, 186, 234, 235, 239, 240) before this landed; each was reconciled via
  the `clear-pos` skill, which as of the same pass also runs this reconciliation automatically
  every tick (`engine/loop.ts`'s `manageLiveOpenTrade`) rather than requiring the operator to
  notice and ask for it.
- Order-flow's directional signal (buy/sell aggressor volume + book imbalance) now feeds v3
  scoring as a bounded adjustment; its accuracy under live conditions still hasn't been
  validated against real outcomes the way the historical-similarity adjustment has, and the
  crowd "Tilt" bias is captured but not yet used for anything (see the entry above).
- `ProjectXGatewayBroker` is implemented to the documented API spec but has never been
  integration-tested — no API credentials exist for this account yet.
- The long-side 67% win-rate gate (`fixedTargetEdgeCache.ts`) still blocks most longs pending
  more real evidence; this is intentional, not a bug.
- Chrome's CDP debug session has occasionally crashed/closed after many hours of continuous
  uptime across dev-server hot-reloads — requires relaunching Chrome with
  `--remote-debugging-port=9222 --user-data-dir=C:\chrome-debug-profile` and logging back into
  TopstepX.
- The backend hit at least one out-of-memory crash after ~45 minutes of uptime; the leading
  suspect (an unguarded, overlap-prone 5-minute outcome-evaluation timer against an unbounded,
  unindexed query) was fixed 2026-07-16 — not yet confirmed against a real multi-hour run.
- Both the backend and frontend dev processes died silently (no crash logged, whole process
  tree gone including the `tsx watch` supervisor) during the initial Docker Desktop
  install/first-run and the `postgres:18` image pull (2026-07-17) — plausibly WSL2
  initialization or the image pull starving the system of resources, but not confirmed. No
  open position existed during the ~38-minute gap this caused, so no real risk exposure, but
  it's a real failure mode worth watching for: heavy local Docker activity may need to be kept
  away from times the engine is actively holding a position.

## Running it locally

```
docker compose up -d           # local Postgres (postgres:18), localhost:5432
cd backend && npm run dev      # Fastify API + engine loop, localhost:8000
cd frontend && npm run dev     # Next.js dashboard, localhost:3000
```

Requires a repo-root `.env` (`POSTGRES_PASSWORD` for the Docker Postgres container),
`backend/.env` (`DATABASE_URL` pointing at that local Postgres, `API_KEY`, broker/price-source
config), and `frontend/.env.local` (`NEXT_PUBLIC_API_KEY`). See `BROWSER_WATCH.md` for the
one-time Chrome launch step required when `PRICE_SOURCE=browser` / `ACCOUNT_SOURCE=browser`.
