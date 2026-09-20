---
name: diagnose-signal
description: How to diagnose "why didn't this trade execute" (or "why did it") from a pasted v1/v2/v3 recommendation row, using the DB and live log as ground truth instead of guessing
---

The operator will paste a Recommendation Feed row (symbol, side, and each version's
probability/decision/explanation) and ask why it did or didn't execute. **Never answer from the
explanation text alone** -- it only shows the per-version score at signal time, not what happened
downstream (consensus, risk, execution). Always trace the real signal through the DB and log.

## Step 1: find the exact score row

Match on symbol/side/version/probability (round to ~0.005 tolerance -- the pasted % is rounded):

```bash
docker exec teratrade-postgres psql -U teratrade -d teratrade -c "
SELECT time, strategy_id, strategy_version, probability, decision
FROM scores
WHERE symbol='NQ' AND side='short' AND strategy_version='v2'
  AND probability BETWEEN 0.915 AND 0.925
ORDER BY time DESC LIMIT 5;"
```

If several rows are close, prefer the most recent one unless the conversation context points to
an earlier one. Once you have the exact `time`, pull all three versions for that timestamp to
confirm the full match (all three probabilities should line up with what was pasted):

```bash
docker exec teratrade-postgres psql -U teratrade -d teratrade -c "
SELECT time, strategy_id, strategy_version, probability, decision
FROM scores WHERE symbol='NQ' AND side='short' AND time='2026-07-21 01:44:08.165'
ORDER BY strategy_version;"
```

This also tells you `strategy_id` -- critical, because the consensus rule differs by signal type
(see Step 2).

## Step 2: check whether consensus was even reached

**One shared rule now** (2026-07-29, operator request -- "v1/2/3 need each other, none should
execute on its own"), used identically by both `determineConsensus` (real strategy signals,
`strategy_id` a real pattern like `breakout_donchian_20`) and `determineContinuousScanConsensus`
(continuous-scan signals, `strategy_id` is `continuous_v3_scan_long`/`continuous_v3_scan_short`) in
`engine/loop.ts`: **at least 2 of the 3 versions must independently clear 75%
(`MUTUAL_AGREEMENT_HIGH_THRESHOLD`), and the remaining (weakest) version must still clear 56%
(`MUTUAL_AGREEMENT_FLOOR_THRESHOLD`)** -- both constants live in `engine/loop.ts`'s
`hasMutualAgreement`. No single strong version can carry a trade with the other two merely
tolerating it; two must genuinely agree at a real bar, and the third can't be far off either.

Compute `sorted = [...probabilities].sort(desc)` yourself from the row and check
`sorted[0] >= 0.75 && sorted[1] >= 0.75 && sorted[2] >= 0.56` -- don't trust the `decision` column
alone to tell you if consensus passed, since `decision` is a per-version threshold check (against
`minScoreThreshold`, 65% by default), not the cross-version consensus rule (75%/75%/56%).

**v3's override**: v3 can show `decision: "taken"` with a raw probability well under 65% -- this
happens when v1 AND v2 both independently agreed already (`gate.ts`'s v1v2Override), hard-overriding
v3's own decision regardless of its own score. Don't be confused by "scored 27% (>= 65% threshold...)"
in the explanation text -- that boilerplate threshold text doesn't change based on the override,
it's just misleading copy.

## Step 3: check the live log for what happened after consensus

Convert the score's UTC `time` to local (this machine is UTC-6, so subtract 6 hours -- e.g. UTC
`19:04` -> local `13:04`), then grep the log:

```bash
tail -n 3000 backend/backend-dev.log | tr -d '\0' > /tmp/tail.txt
grep -n "13:04:1" /tmp/tail.txt
```

Look for, in order: `consensus_reached` (confirms consensus passed) -> `risk_rejected` (S/R
proximity gate or circuit breaker blocked it, `reason` field has the exact math) -> `order_clicked`
+ `trade_opened` (it executed) -- or `order_rejected` (broker-side failure, e.g. a blocking modal
or a DOM timeout).

**If nothing appears at all after `consensus_reached`**: don't assume a hang -- check
`risk_rejected`/`order_rejected`/`trade_opened` more carefully first; a matching bar time with none
of those tags usually means a targeted grep missed it (see the encoding gotcha below), not that the
signal is silently stuck somewhere. (The Execution Decision Engine, which used to have its own
silent `building_entry` re-scoring state here, was removed 2026-08-09 -- every live signal now goes
through the plain market/limit-order path in `execution/engine.ts`, which always logs.)

**Log encoding gotcha**: this file has mixed encoding (parts of it were written by different
process launches) -- plain `grep`/`tail` sometimes silently returns nothing even when a line
exists. If a targeted grep comes up empty but you expect a match, widen the tail window
(`tail -n 6000` or more) before concluding the event never happened, and pipe through
`tr -d '\0'` first every time.

## Step 4: cross-check against the trades table

```bash
docker exec teratrade-postgres psql -U teratrade -d teratrade -c "
SELECT id, symbol, side, status, entry_time, entry_price FROM trades
WHERE symbol='NQ' AND entry_time > '2026-07-21 01:00:00' ORDER BY entry_time DESC LIMIT 5;"
```

No matching row + a `risk_rejected`/`order_rejected` log line = correctly blocked, not a bug.
A matching row + no corresponding log tag = investigate further (see the reconcile-trade skill
if the DB and the real account seem to disagree).

## Common, legitimate reasons a strong-looking signal didn't execute (not bugs)

- **S/R validation gate** (`risk/engine.ts`): "no support/resistance level found nearby" -- a real,
  previously-tested (2+ touch) level must exist near the entry at all. (2026-07-28: the ATR-distance
  band this gate used to also enforce -- `MAX_ENTRY_DISTANCE_ATR`/`MIN_ENTRY_DISTANCE_ATR` -- was
  removed entirely, operator request, after being reactively loosened four times with no backtested
  basis behind the specific bounds. Distance from the level no longer matters, only that one exists.)
- **Directional-conviction margin** (`scoring/gate.ts`'s `MIN_DIRECTIONAL_MARGIN_POINTS`, v3 only):
  "insufficient directional conviction: X scored N vs opposite Y (needs a Z+ point margin)".
- **Continuous-scan floor** (Step 2 above): one version's raw score under the floor.
- Circuit breakers (`max_daily_trades`, consecutive losses, daily loss %) -- check
  `risk_limits` in the DB for the account's actual configured values, since these silently gate
  *every* signal for the rest of the UTC day once tripped (`trades.entry_time`'s day boundary is
  UTC midnight, not local midnight -- see `engine/accounting.ts`'s `computeAccountRiskState`).

All of these hand-set constants live with a comment explaining the reasoning and are meant to be
tuned by direct operator request -- find the constant, read its comment, edit, then typecheck +
run the full suite (`cd backend && npx tsc --noEmit && npm test`). Watch for tests whose fixtures
coincidentally sit right at the old boundary value (seen repeatedly with the old
`MAX_ENTRY_DISTANCE_ATR`/`MIN_ENTRY_DISTANCE_ATR` band before it was removed entirely) -- fix the
fixture to be unambiguously far from *any* reasonable threshold rather than just nudging it past
the new one, so the next tuning pass doesn't hit the same coincidence again.
