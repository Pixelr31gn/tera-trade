---
name: open-gate
description: Check, extend, or close early Tera Trade's temporary S/R proximity gate suspension (risk/engine.ts's MAX_ENTRY_DISTANCE_ATR/MIN_ENTRY_DISTANCE_ATR distance band, suspended via engine/loop.ts's SR_PROXIMITY_GATE_SUSPENDED_UNTIL) -- the 24h-boxed experiment started 2026-08-06 after v6-solo-approved ES/NQ shorts were being vetoed by the distance band
---

`risk/engine.ts`'s S/R proximity gate normally rejects an otherwise-approved trade if its entry
sits outside a 0.25x-1.95x ATR band from the nearest validated support/resistance level. On
2026-08-06 this was suspended for 24 hours (operator request) after the new v6-solo execution
gate (v6 alone at 30%+ auto-executes, see `tune-risk-constant`'s table) started clearing signals
that were then immediately vetoed by this distance band -- concrete example: an ES short approved
at v6=30% consensus, rejected for sitting 2.43x ATR from the nearest resistance level (needed
1.95x). Rather than pick a new permanent band with no evidence, the operator asked to suspend the
check entirely for a fixed window and look at what it actually costs/gains with real data.

**The S/R *validation* requirement is untouched** -- a real, previously-touched (2+ times) level
must still exist near the entry at all. Only the distance-from-it ceiling/floor is suspended.
`srProximityGateSuspended` is threaded in from the impure caller layer (`engine/loop.ts`,
`replay/decisionCore.ts`, `api/routes/scores.ts`) precisely so `risk/engine.ts` itself never calls
`Date.now()`/`new Date()` -- see `SR_PROXIMITY_GATE_SUSPENDED_UNTIL`'s own comment in
`engine/loop.ts` before touching any of this.

**This was built as a time-boxed experiment, not a new default.** If you're extending the same
suspension for the third time in a row with no evidence either way, say so plainly to the
operator instead of just renewing it again -- see the closing section.

Trigger phrases: "open the gate [again]", "extend the S/R suspension", "reopen the gate",
"close the gate early", "is the gate open/closed right now".

## Step 1: check current status first

```bash
grep -n "SR_PROXIMITY_GATE_SUSPENDED_UNTIL" backend/src/engine/loop.ts
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

Compare the two -- if now is before the constant's timestamp, the gate is currently **suspended
(open)**; if after, it's already **active (closed)** again on its own, no action needed unless the
operator wants to re-suspend it.

## Step 2: before extending, look at what the window actually produced

The point of time-boxing this was to gather real evidence, not to quietly make the suspension
permanent. Before renewing, check what happened while it was open:

```bash
grep -a -B2 -A2 "risk_rejected\|consensus_reached" backend/backend-dev.log | grep -a -B2 "resistance level\|support level" | tail -60
```

If it's too early to have real outcomes yet, that's a legitimate reason to extend -- just say so
explicitly rather than implying there's a signal either way when there isn't one.

## Step 3a: extend for another 24h (or a custom duration)

Get the exact current time, compute the new expiry, and edit the constant -- **extend its
revision-history comment, don't replace it**, matching the convention every tuned constant in this
codebase follows (see `tune-risk-constant`'s Step 4):

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

```ts
// 2026-08-06 (operator request, 24h-boxed): ...(existing comment)...
// 2026-08-0X: extended another 24h, operator request -- <cite the Step 2 evidence, or state
// plainly that there's no real evidence yet and more time was requested anyway>.
const SR_PROXIMITY_GATE_SUSPENDED_UNTIL = Date.parse("<new ISO timestamp, UTC>");
```

## Step 3b: close it early instead

Don't delete the mechanism (the constant, `isSrProximityGateSuspended`, or the
`srProximityGateSuspended` plumbing through `risk/tradePlan.ts`/`risk/engine.ts`) -- it's cheap to
keep for next time. Just set the timestamp to a value at/before now, with a dated note why:

```ts
// 2026-08-0X: closed early, operator request -- <why, e.g. "3 of 4 trades that only cleared
// because of this suspension lost">.
const SR_PROXIMITY_GATE_SUSPENDED_UNTIL = Date.parse("<now or earlier, UTC>");
```

## Step 4: typecheck + run the affected tests

```bash
cd backend && npx tsc --noEmit && npx vitest run tests/paperConsensus.test.ts tests/riskEngine.test.ts
```

`tests/paperConsensus.test.ts`'s `isSrProximityGateSuspended` block asserts against two fixed
dates (`2026-08-07T12:00:00Z` expected suspended, `2026-08-09T00:00:00Z` expected not) -- if the
new expiry moves either date to the wrong side of the boundary, update those fixtures the same way
`tune-risk-constant`'s Step 5 describes (move them unambiguously clear of the new value, not just
past it).

## Step 5: report back

State plainly: old expiry, new expiry (or "closed early" / "left as-is"), and whether there's real
evidence behind the call or it's still too early to tell. This directly gates trade approval on a
live (paper) account -- don't bury it in other output.

## If this keeps getting renewed

A "temporary" suspension that gets blindly re-extended every 24 hours is a permanent change wearing
a time limit as a disguise -- exactly what `tune-risk-constant`'s evidence discipline exists to
prevent. If you notice this happening, tell the operator directly: either make a real decision now
(retune `MAX_ENTRY_DISTANCE_ATR`/`MIN_ENTRY_DISTANCE_ATR` to a new permanent band, or restore the
original 0.25x-1.95x band as-is) using `tune-risk-constant`, rather than continuing to renew.
