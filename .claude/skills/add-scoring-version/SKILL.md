---
name: add-scoring-version
description: How to add a brand-new scoring strategy version (v4, v5, ...) alongside the existing v1/v2/v3 rule-based scorers -- every file that must change, and the highest-risk spots that throw at runtime or silently mislabel if missed
---

Tera Trade shadow-scores every signal under all active versions simultaneously (v1, v2, v3
today) so their real performance stays directly comparable -- see `engine/loop.ts`'s
`scoreAllVersions`. Adding a new version means plugging into this shared pipeline, not building
something standalone. Read this whole skill before touching code; several of the failure modes
below throw at runtime, not compile time.

## Step -1: mine real data for a pattern worth encoding (do this before designing logic)

Don't invent factor logic from intuition alone -- `scores.outcome_label` (populated by
`engine/outcomeEvaluator.ts`) gives you a real, resolved outcome for **every** scored setup, not
just the ones that became real trades: `executed_win`/`executed_loss` for setups that were taken,
`missed_win`/`missed_loss` for setups that were skipped/blocked but got retrospectively simulated
forward from their hypothetical entry/stop/target anyway (`missed_win` = "would have won if taken"
-- this is usually the much larger sample, since most scored setups are skipped). `no_resolution`
means still pending (not enough bars have passed) or genuinely inconclusive -- exclude it.
`v3HistoricalAdjustment.ts` already treats `missed_win`/`executed_win` as equally valid "win"
signal for its own similar-setup lookup -- same convention to use here.

Query win rate across a feature dimension, split by `side` (patterns are very often asymmetric
between long and short -- don't average them together):

```sql
SELECT
  side, features::jsonb->>'marketStructureLabel' as bucket, count(*) as n,
  round(100.0 * count(*) FILTER (WHERE outcome_label IN ('executed_win','missed_win')) / count(*), 1) as win_rate_pct
FROM scores
WHERE outcome_label IN ('executed_win','executed_loss','missed_win','missed_loss')
GROUP BY side, bucket HAVING count(*) > 200 ORDER BY win_rate_pct DESC;
```

Swap the `jsonb->>'...'` key for any field in `SetupFeatures` (the full feature vector is stored
as JSON on every row, not just the handful of denormalized columns -- see `Score.features` in
`schema.prisma`) -- `marketStructureLabel`, `liquidityLabel`, `priceActionLabel`, `session`,
`trendLabel`/`volLabel`, `dailyTrendLabel` are all real string labels; for continuous fields
(`adx`, `distanceFromMa20Atr`, `volumeZscore`, `momentum10`, `slopeR2`), bucket with a `CASE`
expression first rather than grouping on the raw float. Require `count(*) > 200`-ish before
trusting a bucket at all -- thin buckets produce noise that looks like signal.

**What this surfaced in one real pass over this account's data** (kept here as a worked example
of the kind of asymmetric, counter-intuitive pattern this method finds -- don't treat these exact
numbers as still current, re-run the query for fresh data): ADX >= 40 (a very-strong-trend
reading) split short-vs-long win rate to 54.8% vs 19.7% -- a massive, sample-rich (n>1400/side)
asymmetry in *opposite* directions from each other, not just "strong trend = good." Separately,
`weak_uptrend`/`weak_downtrend` market-structure labels favored **fading** them (short into
weak_uptrend, long into weak_downtrend) over following them. Neither of these would be an
intuitive factor to hand-design; both only showed up from querying real outcomes.

Once you have 2-4 real, sample-supported, asymmetric-by-side patterns like this, that's your
factor list -- proceed to Step 0 with concrete numbers to encode instead of guessing weights.

## Step 0: pick an architecture

- **v1/v2-style** (weight-summed logit): a flat object of hand-set weights
  (`scoring/ruleScorer.ts`'s `WEIGHTS_V1`/`WEIGHTS_V2`), each factor contributes `weight * raw`
  (raw usually `[-1,1]`) to a running logit, `probability = sigmoid(logit)`. Simple to add a
  factor to, but v2's own extension over v1 is a single hardcoded `if (version === "v2")` block
  inside `scoreSetup()` -- there's no generic "for each version, add its extra weights" loop.
- **v3-style** (points + bounded adjustments): a fixed 100-point spread across a small number of
  core factors (`scoring/ruleScorerV3.ts`'s `scoreSetupV3Directional`, both bull AND bear
  hypotheses scored every time), plus separate, individually-bounded additive adjustments
  (fib, ppm, risk:reward, order-flow, breakout-strength, historical-similarity) layered on top
  and clamped to `[0,100]`. More work to stand up, but gives you real headroom for hard gates
  (directional-conviction margin) and per-factor point budgets that don't drift with logit math.

Whichever you pick, decide up front whether the new version needs a **conviction/margin gate**
(v3-only today, `MIN_DIRECTIONAL_MARGIN_POINTS` in `gate.ts`, requires scoring both hypotheses)
or an **override rule** like v3's `shouldOverrideToTaken` (v1+v2 agreement force-flips v3) --
neither generalizes automatically; both are hardcoded to the specific versions involved.

## Step 1: the scoring module itself

- v1/v2-style: extend `WEIGHTS_V1`/add a new `WEIGHTS_VN` in `ruleScorer.ts`, and add your own
  `if (version === "vN") { ...append factors... }` block inside `scoreSetup()`, mirroring the
  existing v2 block exactly.
- v3-style: a new `ruleScorerV{N}.ts` module, mirroring `ruleScorerV3.ts`'s shape: a
  `scoreForSide()`-equivalent returning both hypotheses off one `V{N}AbsoluteReadings` object,
  a directional-scoring entry point, and any adjustment functions as small, individually-tested
  pure functions (each with a named `MAX_*_ADJUSTMENT` bound constant, not a magic number).

`SetupFeatures`/`buildSetupFeatures` (`scoring/features.ts`) is fully version-agnostic and
reusable as-is -- only touch it if the new version needs genuinely new raw input data.

## Step 2: wire into `gate.ts`

`evaluateSetup(features, version, v3Inputs?)` dispatches by a literal `if (version === "v3")`
block, entirely separate from the shared v1/v2/v4 path. A v3-style new version needs its own
top-level `if (version === "vN")` branch here, mirroring v3's. A v1/v2-style new version instead
falls through the *shared* branch (which calls `ruleScorer.ts`'s `scoreSetup` and only
special-cases `"v4"` for the ML scorer).

**Highest-risk gotcha in this file**: `GatedScore.modelUsed` is a closed union
(`"rule_v1" | "ml_v4" | "rule_v1_fallback" | "rule_v3"`) and the code that sets it does
`if (version === "v4") { ml } else { modelUsed = "rule_v1" }` -- **any version that isn't
literally `"v3"` or `"v4"` silently gets mislabeled `"rule_v1"`**, even a real, correctly-scored
new version. Add a new literal to the union AND fix the branch, or every Score row from the new
version will misreport which model actually scored it.

If the new version needs its own conviction gate or override rule, it needs its own constant
(don't reuse `MIN_DIRECTIONAL_MARGIN_POINTS`, it's read directly inside the v3 branch only) and
its own plumbing (don't try to reuse `shouldOverrideToTaken`'s signature, it hardcodes
`v1Gated`/`v2Gated` as named params, not a generic "other versions" list).

## Step 3: wire into `engine/loop.ts`

1. Add the new version to `STRATEGY_VERSIONS: StrategyVersion[]` -- this is the single source of
   truth `scoreAllVersions()` iterates, and it generalizes automatically (creates one Score row
   per version per signal) once added.
2. Decide its slot in `CONSENSUS_REPRESENTATIVE_ORDER` (which version's explanation "wins" when
   consensus is reached).
3. **Decide the majority-vote policy, don't just let it inherit one.**
   `determineConsensus`'s threshold is a hardcoded `clearingVersions.length >= 2` -- for 4
   versions this needs an explicit operator decision (strict majority = `>=3`? still `>=2`?
   something else?), not silent inheritance of the 3-version number. Its summary string is also
   a literal `"/3"`, not templated from `STRATEGY_VERSIONS.length` -- fix both or it'll misreport.
   `determineContinuousScanConsensus`'s min/max floor+standout math *does* generalize cleanly
   (no hardcoded count) -- no change needed there beyond the version list itself.
4. Both consensus functions do `gatedByVersion.get(v)!` (non-null assertion) for every entry in
   `STRATEGY_VERSIONS` -- **every caller that builds a `gatedByVersion` map must supply an entry
   for the new version, or this throws at runtime**, not a type error. Grep for
   `gatedByVersion` construction sites before assuming this is done.

## Step 4: the runtime-crash trap in `api/routes/scores.ts`

`/api/recommendations/actionable` gates whether `determineConsensus` gets called at all behind
`if (!versions.has("v1") || !versions.has("v2") || !versions.has("v3")) continue;` -- a manual,
hardcoded completeness check completely separate from `STRATEGY_VERSIONS`. If you add a version
to `STRATEGY_VERSIONS` but don't add `|| !versions.has("vN")` here too, the first real 4-version
signal that reaches this endpoint calls `determineConsensus` with an incomplete map and **throws**
at the `gatedByVersion.get(v)!` line above. This is the single easiest step to forget and the
only one that fails in production traffic rather than in a test run.

## Step 5: frontend literal unions and lists (cosmetic but numerous)

All of these currently hardcode `"v1"|"v2"|"v3"|"v4"` or `["v1","v2","v3"]`-shaped lists and need
the new version added:

- `frontend/lib/types.ts`: `SystemState.activeStrategyVersion`, `RecommendationScore.strategyVersion`,
  `ActionableRecommendation.strategyVersion`, `StrategyComparison`'s `Record` key union (4 spots).
- `frontend/app/recommendations/page.tsx`: `VERSION_FILTERS`, `REAL_VERSIONS`, two
  `strategyVersion === "v3" || "v4"` badge-tone ternaries, and prose text describing the
  consensus rules (check this prose is even still accurate for the *existing* versions before
  editing -- it was already stale re: the continuous-scan floor % as of 2026-07-20).
- `frontend/app/strategy/page.tsx`: `VERSIONS`, `VERSION_DESCRIPTIONS` (needs a new blurb),
  `md:grid-cols-3`/`lg:grid-cols-3` (cosmetic, assumes exactly 3 columns), prose hardcoding
  "v1, v2, and v3" / "2 of the 3 versions".
- `backend/src/api/routes/system.ts`: manual string validator on the (vestigial, execution
  doesn't read it) `/api/system/strategy-version` endpoint.
- `backend/src/api/routes/analytics.ts`: `computeVersionDivergence`/`computeStrategyComparison`
  both hardcode a local `versions = ["v1","v2","v3","v4"] as const` array -- these otherwise
  generalize fine (the aggregation loops over the array), just widen it and the return type.

## Step 6: tests

- `backend/tests/paperConsensus.test.ts`'s local `map(v1, v2, v3)` helper hardcodes exactly 3
  map entries -- `determineConsensus`/`determineContinuousScanConsensus` will throw against it
  once `STRATEGY_VERSIONS` includes a 4th version and the map doesn't. Add a parallel helper (or
  extend it) and new cases for the new version's presence/absence.
- New scoring logic gets its own test file (mirror `ruleScorerV3.test.ts` for a v3-style version,
  or add cases to `scoring.test.ts` for a v1/v2-style one). Convention: each test file defines its
  **own local** `features(overrides = {})` fixture literal (there's no shared factory in
  `tests/fixtures.ts` -- that file only has bar generators) with neutral defaults, override just
  the fields under test, and assert *relative* comparisons (`aligned.probability > counter.probability`)
  rather than magic numbers, except where there's an exact documented bound or worked example to
  pin down.
- `backend/tests/engineIntegration.test.ts` is DB-backed (`describe.skipIf(!hasRealDb)`) and
  already has stale comments/assertions about "exactly one v1 + one v2 per signal" relative to
  today's 3-version reality -- don't trust its existing assertions as ground truth for version
  count; update them if you touch this file at all.

## Nothing needed for these (verified reusable as-is)

`Score.strategyVersion` in `schema.prisma` is a plain string column (no enum, no migration
required for a new value) with generic indexes already keyed on it. `FactorContribution`/
`ScoreResult`/`explainScore` are fully generic. `fibDirectionSignal`/`ppmDirectionSignal`
(shared by v1/v2/v3 already) are reusable by a new version too. `scoreAllVersions` itself needs
no changes beyond the `STRATEGY_VERSIONS` list (Step 3.1).

## Verification

`cd backend && npx tsc --noEmit && npm test`, then drive a real signal through
`runContinuousScan` (or wait for a live tick) and confirm via the DB that exactly
`STRATEGY_VERSIONS.length` Score rows land per signal, `modelUsed` reads correctly (not
mislabeled per Step 2), and `/api/recommendations/actionable` doesn't 500 -- see the
`diagnose-signal` skill for how to trace a specific signal through consensus/risk/execution
once scoring itself is confirmed working.
