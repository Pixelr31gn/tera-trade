---
name: reconcile-trade
description: How to fix Tera Trade's trades table when it disagrees with the real TopstepX account -- phantom trades, missed fills, and undetected closes
---

Tera Trade's own database is not always ground truth -- it's only as good as the DOM automation
and price feed that feed it. Three distinct failure shapes have happened live; diagnose which one
you're looking at before touching the database.

## First: always get the operator's direct confirmation of the real account state

Never assume from Tera Trade's own API/DB what's actually true on the real account. Ask
specifically what they see on the TopstepX screen (a filled position vs. a still-pending order,
open vs. closed, the real quantity/side) -- your own read-only DOM checks (see
browser-automation-dev skill) can corroborate, but the operator's direct look at their own screen
is the actual source of truth, and has caught the automation being wrong more than once tonight.

## Failure shape 1: phantom trade (a DB row that doesn't correspond to any real fill)

**As of v1.3, this specific root cause is fixed, and any occurrence is reconciled automatically.**
`browserControlBroker.placeOrder()` no longer reports a market order as `"filled"` off a bare
successful click -- it now confirms via `isPositionFlat` first (see `clear-pos`'s closing section
for the exact mechanism), so this shape shouldn't occur going forward. Belt-and-suspenders,
`engine/loop.ts`'s `manageLiveOpenTrade` also checks `isPositionFlat` unconditionally every tick for
ES/NQ now (not just after our own stop/target levels cross) and auto-closes via
`reconcileBrokerFlatTrade` (exit price/pnl left null, flagged `[AUTO-RECONCILED ...]`) if a phantom
row still turns up. See the `clear-pos` skill to force it immediately rather than wait for the next
tick, or for a symbol outside ES/NQ where this doesn't apply. If this shape recurs after the fix,
treat it as a new bug worth investigating, not a repeat of the same one.

Symptom: a `trades` row exists (often "open") but there's no matching real position, or its
numbers don't add up (wrong side/quantity/entry price relative to what's real). Root cause seen
live: the Execution Decision Engine's in-memory opportunity map was keyed by symbol alone, so an
opposite-side signal for the same symbol collided with an already-resting opportunity's slot and
fabricated a trade from mismatched data (the "position exists" check was real, but the trade
details recorded came from an unrelated signal).

Fix: delete the row (and anything referencing it), don't just mark it closed with fake exit data
-- it never really existed as a position:

```sql
BEGIN;
DELETE FROM orders WHERE trade_id = <id>;
UPDATE scores SET trade_id = NULL WHERE trade_id = <id>;
DELETE FROM trades WHERE id = <id>;
COMMIT;
```

Then find and fix the code bug that produced it -- a phantom trade is always a symptom of a real
bug, never treat the cleanup as the fix.

## Failure shape 2: real fill never recorded (Tera Trade thinks a symbol is flat, it isn't)

Symptom: `hasOpen`-style checks show a symbol as free to trade, but a real position exists.
Root causes seen live: (a) the fill-detection poll was only reachable from a fresh signal
re-clearing consensus, so it silently stopped running once that stopped happening; (b) an
in-memory opportunity's fill check depends on `isPositionFlat`, which needs the order-entry
widget to actually be showing the right contract -- if something switched it to a different
symbol in between, the check can't confirm either way.

Fix: manually create the trade row with the real, operator-confirmed numbers (entry price,
side, quantity, stop/target as actually set on the real bracket if any). Get the exact stop/take
profit from the operator reading them off TopstepX directly -- don't estimate these if avoidable,
they'll drive real risk-management decisions (`manageLiveOpenTrade` in `engine/loop.ts`) going
forward:

```ts
const trade = await prisma.trade.create({
  data: {
    accountId: 1, symbol: "NQ", strategyId: "continuous_v3_scan_short", side: "short",
    quantity: 3, entryTime: new Date(), entryPrice: "28876", stopPrice: "28901",
    takeProfitPrice: "28824", score: "0.7804",
    explanation: "MANUAL RECONCILIATION (<date>): <what happened and why, in enough detail" +
      " that a future reader understands this wasn't a normal entry>.",
    status: "open", brokerOrderId: "browser-manual-reconcile", brokerKind: "browser_control",
  },
});
await prisma.score.update({ where: { id: <matching score id> }, data: { tradeId: trade.id } });
await prisma.orderRecord.create({ data: { tradeId: trade.id, brokerOrderId: "browser-manual-reconcile",
  accountId: 1, symbol: "NQ", orderType: "limit", side: "short", quantity: 3, price: "28876",
  status: "filled", filledAt: new Date(), filledPrice: "28876" } });
```

**Critical field, easy to miss**: `brokerKind` must be set explicitly to match the real broker
(`"browser_control"`, not the schema's `"simulated"` default) -- `manageOpenTrades` branches on
this to decide whether to actually manage the position live or treat it as paper (where "closing"
it is a silent no-op against a fake in-memory broker that never had the position). A manually-run
script or route that forgets this field produces a *worse* bug than the missed fill itself: Tera
Trade will believe it's managing a real position while actually doing nothing.

## Failure shape 3: real close never detected (Tera Trade still shows it open)

Symptom: operator confirms a position is closed on the real account (via TopstepX's bracket, a
manual close, or anything else), but Tera Trade's `trades` row is still `status: 'open'`.

**Important limitation to know before diagnosing**: `manageLiveOpenTrade` only checks the real
broker state *after* Tera Trade's own price data shows the stored stop or target was crossed --
it has no independent, periodic "is this still really open" poll. So an out-of-band close (the
operator closing manually, or anything broker-side unrelated to the stop/target) will not be
noticed on its own, ever, regardless of how long it's been closed. Check whether the current
price actually crossed the stored stop/target first:

```sql
SELECT stop_price, take_profit_price FROM trades WHERE id = <id>;
```
```sql
SELECT time, close FROM bars_1m WHERE symbol='NQ' ORDER BY time DESC LIMIT 5;
```

If price never crossed either level, this confirms the gap above, not a detection bug -- close it
out with an operator-confirmed (or clearly-labeled-estimated) exit price:

```sql
UPDATE trades SET status='closed', exit_time=NOW(), exit_price=<price>, exit_reason='manual',
  pnl=<computed>,
  explanation = explanation || ' [CLOSED <date>: operator confirmed this was no longer open on'
    || ' TopstepX (cause unconfirmed -- not a stop/target hit per our own price data). Exit price'
    || ' is an ESTIMATE (latest bar close at reconciliation time), not a confirmed broker fill.]'
WHERE id = <id>;
```

pnl sign convention: `(exitPrice - entryPrice) * pointValue * quantity` for a long,
`(entryPrice - exitPrice) * pointValue * quantity` for a short. Point values live in
`marketData/instruments.ts` (`ES`=5, `NQ`=2 per point, as of this build).

## After any reconciliation

Verify via the actual API, not just the raw SQL result, since that's what the dashboard and the
engine's own `hasOpen` checks actually read:

```bash
curl -s -H "x-api-key: $API_KEY" http://localhost:8000/api/positions
```
