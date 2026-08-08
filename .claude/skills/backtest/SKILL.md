---
name: backtest
description: How to diagnose a strategy version stuck at "n/a"/"Resolved 0" on the Strategy Version Performance dashboard despite real setup volume, and how to force-catch-up its outcome-label backlog with the one-off backfill script instead of waiting on the live 5-minute evaluator
---

Every scored setup (taken or skipped) eventually gets a retrospective `outcome_label` from
`backend/src/engine/outcomeEvaluator.ts`'s `evaluatePendingOutcomes()`, run on a 5-minute timer
(`backend/src/index.ts`). This is what the dashboard's "Strategy Version Performance" panel and
`analytics.ts`'s `computeStrategyComparison()` read their win rates from. A version can look
completely dead on that panel (`n/a` win rate, `Resolved: 0`) while actually having thousands of
real recorded setups -- that's a backlog-starvation symptom, not necessarily missing data.

## Step 1: confirm it's starvation, not "genuinely too new"

```bash
docker exec teratrade-postgres psql -U teratrade -d teratrade -c "
SELECT strategy_version, count(*) as pending_count, min(time) as oldest, max(time) as newest
FROM scores
WHERE outcome_label IS NULL AND trade_id IS NULL
GROUP BY strategy_version ORDER BY strategy_version;"
```

If the suspect version's `oldest` pending row is many days newer than another version's
`oldest` pending row, and that other version has a much bigger pending backlog, that's the
signature: `evaluateSkippedScores` used to pull its entire `MAX_ROWS_PER_PASS` (200) budget from
one global oldest-first query with no per-version split -- a version whose backlog started more
recently could never reach the front of the queue while an older, bigger backlog kept refilling
it. This was hit for real on 2026-07-29: v5 (scoring since 2026-07-21) had **zero** resolved out
of 16,000+ setups because v1/v2/v3's backlog (since 2026-07-10, tens of thousands of rows) always
consumed the whole pass. Fixed by giving every version with pending rows its own fair slice of
the per-pass budget (see the `groupBy strategyVersion` + per-version `take` in
`evaluateSkippedScores` now) -- so this specific failure mode shouldn't recur, but the same
diagnostic query is still the right first move any time a version looks stuck, since the fair
split only bounds *future* starvation, not how fast a big existing backlog drains.

Also sanity-check total daily inflow vs. capacity -- if new pending rows arrive faster than the
per-pass budget can drain (real on this account: several thousand/day vs. ~2,880/day theoretical
max at 200/pass every 5 min), the backlog is structurally growing, not just historically large,
and the live evaluator alone will never fully catch up on its own pace.

## Step 2: force-catch-up with the one-off backfill

`backend/scripts/backfillOutcomes.ts` reuses the exact same per-row simulation logic as the live
evaluator (`evaluateSkippedScoreRow`, exported from `outcomeEvaluator.ts` for this reason) but
loops over **all** of one version's pending backlog instead of a throttled 200-per-5-minutes
slice. This is safe to run any time -- it's pure retrospective labeling (reads `bars`, simulates
the stored hypothetical entry/stop/target forward, writes `outcome_label`/`outcome_r_multiple`),
never touches live trading, execution, or the broker.

```bash
cd backend && npx tsx scripts/backfillOutcomes.ts v5
```

Most of a backlog is usually already old enough (days old) to have the required 50+ bars to
judge against -- it was just stuck behind the throttle, not actually waiting on real time to
pass. The script stops itself once a full round updates nothing (meaning everything left is
genuinely too recent to judge yet), so it's safe to just let it run to completion. For a backlog
in the tens of thousands, run it in the background and check its output periodically rather than
blocking on it.

## Step 3: read the real number, honestly

```sql
SELECT
  count(*) FILTER (WHERE outcome_label IN ('executed_win','missed_win')) as wins,
  count(*) FILTER (WHERE outcome_label IN ('executed_loss','missed_loss')) as losses,
  count(*) FILTER (WHERE outcome_label = 'no_resolution') as no_resolution,
  count(*) FILTER (WHERE outcome_label IS NULL) as still_pending
FROM scores WHERE strategy_version = 'v5';
```

Win rate = `wins / (wins + losses)` -- matches `analytics.ts`'s `OUTCOME_POSITIVE`/
`OUTCOME_NEGATIVE` sets and `computeStrategyComparison`'s `resolvedCount` math exactly.
`no_resolution` and still-pending rows are excluded from the denominator, not counted as losses.

**Don't trust a small `n`.** Same guidance as `add-scoring-version`'s Step -1 (require
`count(*) > 200`-ish before treating a bucket as real signal) -- right after a backfill, most of
a version's setups may still be `no_resolution`/pending if the version is brand new, so state the
sample size alongside the win rate rather than reporting a bare percentage.

## When to reach for this

- Right after standing up a new scoring version (`add-scoring-version` skill) -- don't wait days
  for its first real dashboard numbers, backfill it once it has a few days of signals.
- Any time a version's dashboard panel shows `n/a`/`Resolved: 0` (or a suspiciously low resolved
  count) despite real setup volume -- run Step 1's query before assuming the number is trustworthy
  as-is.
