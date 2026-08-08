---
name: clear-pos
description: Operator has confirmed directly on TopstepX that one or more positions shown as open on the Tera Trade dashboard don't actually exist on the real account -- clear them all out fast
---

**As of v1.3, this runs automatically, and the root cause is fixed.** `engine/loop.ts`'s
`manageLiveOpenTrade` calls `isPositionFlat` unconditionally on every tick for every open live
trade on ES/NQ (not just after our own stop/target levels are crossed) -- if the broker confirms
flat and our DB still shows the trade open, it's reconciled automatically via
`reconcileBrokerFlatTrade`, exactly per Step 2's fallback below (closed, exit price/pnl left null,
explanation flagged `[AUTO-RECONCILED ...]`, `exit_reason: 'auto_reconciled'`). Separately (same
pass), `browserControlBroker.placeOrder()` no longer reports a market order as `"filled"` the
instant the click succeeds -- it now polls `isPositionFlat` a few times first (see the closing
section) and treats "still flat" the same as a broker rejection, so new phantom trades shouldn't
get created going forward at all. **This manual skill is now mainly for**: (a) a trade created
*before* this fix landed, (b) the rare case the fix itself doesn't catch (e.g. a position that
filled then closed again within the confirmation window), or (c) the operator wanting it cleared
immediately rather than waiting for the next tick.

Trigger phrase: the operator says something like "these aren't open on TopstepX, close them out" /
"clear positions" after looking at their real account directly. That direct confirmation is
sufficient to act -- don't re-diagnose from scratch (see `reconcile-trade`'s fuller framework for
when the real/phantom status is still ambiguous and needs establishing first; this skill is for
when the operator has already told you it's phantom).

Recurred 6 times in one session before the root-cause fix landed (trade IDs 185, 186, 234, 235,
239, 240) -- if you see it recur *after* the fix, that's worth flagging as a new, different bug,
not the same one again.

## Step 1: see what's actually showing as open

```bash
API_KEY=$(grep -m1 '^API_KEY=' backend/.env | cut -d= -f2-)
curl -s http://localhost:8000/api/positions -H "x-api-key: $API_KEY"
```

Note every `tradeId` returned -- all of them are in scope unless the operator specifically named
which ones are phantom and which (if any) are real.

## Step 2: clear them out

Prefer a real DELETE (matching `reconcile-trade`'s Failure Shape 1 -- a phantom trade never really
existed as a position, so don't fake-close it with invented exit data):

```sql
BEGIN;
DELETE FROM orders WHERE trade_id IN (<ids>);
UPDATE scores SET trade_id = NULL WHERE trade_id IN (<ids>);
DELETE FROM trades WHERE id IN (<ids>);
COMMIT;
```

**If the auto-mode classifier blocks the direct DELETE** (observed this session -- destructive raw
SQL against a live trading DB gets flagged), fall back to marking them closed instead, explicitly
leaving exit data null rather than fabricated, and labeling the row clearly:

```sql
UPDATE trades SET
  status = 'closed',
  exit_time = NOW(),
  exit_reason = 'manual',
  explanation = explanation || ' [FLAGGED <date>: operator confirmed directly on TopstepX that no'
    || ' such position ever existed on the real account -- phantom trade row, not a real fill.'
    || ' Marked closed (not deleted -- classifier blocked direct DELETE this session) so it stops'
    || ' appearing as an open position on the dashboard and no longer blocks new signals for this'
    || ' symbol via the engines hasOpen check. exit_price/pnl intentionally left null rather than'
    || ' fabricated, since there was never a real entry or exit to compute them from.]'
WHERE id IN (<ids>);
```

Either way, explain to the operator which path you took and why -- a fake-closed row with real-
looking exit data would silently corrupt PnL/analytics history, so never fabricate a number here
just to fill the column.

## Step 3: verify

```bash
curl -s http://localhost:8000/api/positions -H "x-api-key: $API_KEY"
```

Must return `[]` (or only the IDs the operator didn't flag). This is what the dashboard and the
engine's own `hasOpen` pre-entry check both read, so confirming here confirms both.

## Root cause (fixed)

Every occurrence traced back to the same gap: `browserControlBroker.placeOrder()` treated a
successful Buy/Sell button click as a confirmed fill, with no verification a real position
actually appeared on the account afterward. If TopstepX silently rejected an order post-click (a
lockout, a margin check, anything that doesn't throw a Playwright exception), Tera Trade recorded
a permanent "open" trade that was never real -- `execution/engine.ts` never needed changing, since
it only ever trusted whatever `placeOrder` reported.

Fixed by adding `confirmPositionOpened` inside `placeOrder` itself: after a market-order click
succeeds, it polls `isPositionFlat` (`FILL_CONFIRMATION_RETRIES` attempts, `FILL_CONFIRMATION_DELAY_MS`
apart -- both in `browserControlBroker.ts`) before ever reporting `status: "filled"`. A persistent
"still flat" or unresolvable ("can't tell") result is now treated the same as a broker rejection.
This is the one place "don't guess" (isPositionFlat's usual convention) is deliberately overridden
by "when unsure, don't record a trade" -- the two failure directions aren't symmetric: a missed
real fill is reconcilable later (see `reconcile-trade`'s Failure Shape 2), but a phantom trade
silently pollutes real risk tracking until someone notices.

If this recurs after the fix, it's a new bug, not the same one -- go find out why
`confirmPositionOpened` didn't catch it (e.g. `isPositionFlat` itself returning a false "not flat"
reading, or a fill that happened then closed again within the ~3s confirmation window) rather than
assuming it's the original gap again.
