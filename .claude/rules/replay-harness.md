# Rule: replay harness

Applies to `src/replay/`, `engine/loop.ts`, `scoring/`, and any refactor that
touches the decision pipeline.

## Why this exists

Tuned constants and gate rules in this codebase were set by watching live
sessions for hours — `MAX_ENTRY_DISTANCE_ATR` changed seven times in nine
days; the consensus rule was reshaped three times in one day. The harness
replays historical bars through the real decision pipeline so those questions
get answered with samples and error bars instead of an afternoon's impression.

## The one rule that matters

**Live and replay call the same decision code.** `decideOnBar()` in
`src/replay/decisionCore.ts` is the extracted body of
`TradingEngine.evaluateNewSignals` (engine/loop.ts:842). Once extracted,
`onNewBar` calls it too.

Never write `if (isReplay)` inside `strategy/`, `scoring/`, `risk/`, or
`analytics/`. Never create a second copy of the consensus rule, the scoring
order, or the stop math. The instant those paths diverge, the harness is
describing a system nobody runs, and every number it produces is a lie you'll
act on.

Everything that legitimately differs goes behind `DecisionContext`
(`src/replay/types.ts`).

## Seam map

Already pure — replay these unchanged, do not refactor:
`classifyRegime` · `Strategy.generateSignal` · `computeAtr` ·
`computeInitialStop` · `classifySession` · `buildSetupFeatures` ·
`scoreSetup` / `scoreSetupV3Directional` / `scoreSetupV5` ·
`RiskEngine.assessNewTrade` · `evaluateHypotheticalOutcome`

Impure — these eight are the entire injection surface, and every one takes an
`at: Date` in `DecisionContext`:
`loadRecentBars` · `prisma.trade.findFirst({status:"open"})` ·
`getNewsRiskStatus` · `getOpeningRangeStats` · `getDailyTrend` ·
`getDailyEma20Trend` · `getFixedTargetEdge` · `getLatestOrderFlowSnapshot` ·
`computeAccountRiskState`

Live implementations ignore `at` and keep their existing TTL caches, so live
behaviour is unchanged by the extraction. Prove that before moving on.

## Look-ahead landmines — fix before trusting any result

1. **`scoring/v3HistoricalAdjustment.ts:47`** — `prisma.score.findMany` filters
   on resolved `outcomeLabel` with **no time bound**. Harmless live (only past
   scores exist); in replay it reads outcomes from after the bar being scored.
   Add `time: { lt: at }`.
2. **`engine/fixedTargetEdgeCache.ts:59`** — same shape,
   `orderBy: { time: "desc" }, take: N`, unbounded. Same fix.
3. **Entry fills at the NEXT bar's open**, never the close that triggered the
   decision. Live cannot act on a bar it has not finished seeing.
4. **Same-bar stop/target ties resolve to the stop.** This is the house rule
   already set by `analytics/outcomeSimulation.ts` and
   `SimulatedBroker.evaluateBar`. All three must agree; there is a test for
   that.
5. **Costs are not optional.** Subtract Topstep round-turn commission and one
   tick of slippage per side. At this trade frequency, omitting them is the
   difference between a strategy and a spreadsheet.

## Fidelity limits — report, don't hide

- `orderFlowSnapshot` is **always null in replay**. CDP order flow cannot be
  backfilled, so v5 and v3's order-flow adjustment score differently than they
  do live. Every `BarDecision` carries `degraded[]`; every `ReplayResult`
  reports `degradationRate`. Surface it in any summary you produce.
- The broker-side trailing stop moves tick-by-tick; replay sees 5-minute OHLC
  and cannot order the high against the low within a bar. Trades that arm and
  exit the trail inside one bar are unresolvable — count them separately.

## Scoring order is load-bearing

`evaluateSetup(features, version, v3Inputs?)` is **positional**. v3 requires
`{ bars, v1Gated, v2Gated, signalKind }` and therefore must run *after* v1 and
v2, because it uses their results for its v1v2Override. Do not parallelize the
version loop with `Promise.all` — that silently disables the override.

v5 is scored on every signal but excluded from `determineConsensus`. Keep it
that way until a harness result justifies promotion.

## Definition of done for Phase 1

The harness is not trustworthy until this passes: replay a window that was
traded live, and assert its decisions match the stored `Score` rows for the
same bars. Any mismatch is a harness bug, not a market finding. Write that
test before running a single parameter sweep.

## Reporting results

Always report expectancy in R with its standard error, never win rate alone.
With ~40 trades a 0.15R improvement is indistinguishable from noise. If a
sweep's best result is inside one standard error of the current setting, the
honest answer is "no evidence of a difference" — say that, don't pick the
higher number.

Walk-forward any parameter change: fit on one window, evaluate on the next.
Nine days of ES will overfit anything.
