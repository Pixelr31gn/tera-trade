# Browser Control: placing real orders without a ProjectX API key

`BrowserControlBroker` places real orders by driving TopstepX's web UI directly (mouse/keyboard
automation over the same CDP connection [BROWSER_WATCH.md](BROWSER_WATCH.md) uses read-only),
built because the account has no ProjectX Gateway API credentials. This is fundamentally
different from browser-watch: it actually clicks Buy/Sell/Close on your real, funded account.

Read this whole document before enabling it. UI automation is inherently more fragile than a
real API (a layout change, a covered element, a slow page load can all cause a misfire), and
you are automating real order entry on a real funded account.

## How it works

1. Connects to your already-open, already-logged-in TopstepX tab via CDP (same mechanism as
   browser-watch -- no browser is launched or downloaded).
2. Finds the order-entry widget currently showing the instrument's contract (matched by CME
   contract code, e.g. "MNQU26" for a September 2026 Micro Nasdaq contract).
3. Sets the quantity the risk engine sized the trade to.
4. Clicks Buy or Sell.

**2026-07-21 update: no longer configures TopstepX's own Position Brackets.** An earlier version
of this automation also filled in `Risk (~$)` / `Profit (~$)` and checked "Automatically apply
Risk / Profit bracket to new Positions" before submitting. That popover's own button row switches
from "Close" to "Cancel"/"Save Changes" once anything in it is edited, and the first cut of this
automation kept clicking "Close" -- which discards the edit -- while every readback check still
looked correct, since those checks only ever read the popover's own live input state, not whether
anything was actually persisted. This produced two real, confirmed unprotected live positions in
one night before being caught. Rather than keep hardening that DOM interaction, the operator chose
to drop it entirely: every open position's real protection is now `engine/loop.ts`'s
`manageLiveOpenTrade`, which polls every price tick against the trade's own stop/target and
actively force-closes the position the moment either is crossed, independent of anything
broker-side. Known tradeoff, accepted knowingly: while the backend itself is down, an open
position has no stop at all, since nothing broker-side is watching it either.

If TopstepX is showing any modal dialog (loss-limit lockouts, etc.) when an order is attempted,
placement is refused immediately with the modal's text rather than retrying against a covered
element for 30 seconds.

## Contract prefix, not full-size symbols

Tera Trade's canonical symbols (`ES`/`NQ`/`CL`/`GC`) and their Yahoo-sourced price history are
unchanged -- micro futures track the identical underlying price series as their full-size
counterparts, just with a smaller contract multiplier. `marketData/instruments.ts` adds a
`brokerContractPrefix` field (`MES`/`MNQ`/`MCL`/`MGC`) used only to find the right order-entry
widget, and `pointValue` reflects the actual micro contract multiplier so position sizing and
realized P&L are correct for what's actually traded. **If your account trades full-size
contracts instead, update both fields back before using this broker.**

Only one order-entry widget needs to exist per symbol you want automated -- if a symbol has no
matching widget in your TopstepX layout, `placeOrder`/`requestClosePosition` fail clearly
rather than guessing.

## Going live -- four independent opt-ins required

Real clicks require **all four** of:

```
TRADING_MODE=live
BROKER_KIND=browser_control
LIVE_TRADING_CONFIRMED=true
DRY_RUN_ORDERS=false
```

`execution/mode.ts` enforces that `PAPER` mode can only ever use `BROKER_KIND=simulated` (so
"paper" can never accidentally mean real orders) and that `LIVE` mode requires a real broker
kind plus `LIVE_TRADING_CONFIRMED=true`. `DRY_RUN_ORDERS` is a separate, independent flag
checked inside `BrowserControlBroker` itself, **defaulting to `true`**.

### Dry run (default)

With `DRY_RUN_ORDERS=true` (or unset), every step short of the final click still happens for
real -- the correct widget is found and quantity is set -- so you can watch the real screen and
confirm it's targeting the right instrument with the right numbers. The Buy/Sell/Close button itself is
highlighted (a red outline) instead of clicked, and the order is recorded as rejected with a
`DRY_RUN_ORDERS is enabled -- would have clicked "..."` reason, visible in the recommendation
feed/live event stream. No `trades` row is created for a dry-run "order".

Watch several of these against real setups before ever setting `DRY_RUN_ORDERS=false`.

## Closing a position

There's a manual "Close" button next to each open position on the Positions dashboard page,
which calls `POST /api/positions/:tradeId/close`. This clicks TopstepX's own "Close Position"
button for that symbol's widget (also respecting `DRY_RUN_ORDERS`).

## Known limitation: no automatic detection of broker-side closures

This module only acts on command (place, close). It does **not** yet detect when TopstepX's own
bracket order closes a position server-side (stop or target hit) -- unlike `SimulatedBroker`,
which evaluates every bar against the stop/target it's tracking itself. A `trades` row opened
via `BrowserControlBroker` stays `status: "open"` in the database until you close it via the
dashboard button, even if the real position already closed on TopstepX's side. Reconciling this
automatically (e.g. by polling the account/positions data TopstepX exposes) is a real gap, not
yet built.

## Topstep's rules

Many prop firms restrict or prohibit automated/bot order entry through their web platform as
opposed to an official API. This wasn't independently verified against Topstep's specific terms
before building this -- confirm you're comfortable with that before enabling `DRY_RUN_ORDERS=false`.
