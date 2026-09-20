---
name: daily-plan-fallback
description: Manually build and set today's daily-plan zones (support/resistance boundaries) and take-profit target for ES/NQ when the automated Gemini-driven scheduler (assistant/dailyPlanScheduler.ts) is stuck -- rate-limited, quota-exhausted, or otherwise failing -- so the session doesn't trade with the daily-plan-range gate as a no-op until the next successful automated refresh
---

`assistant/dailyPlanScheduler.ts` pre-triggers 5 minutes before each session boundary
(New York/London/Asian) and asks the AI assistant (Gemini, free tier) to set two things per
symbol: `set_daily_plan_zones` (a support boundary and a resistance boundary -- see
`risk/engine.ts`'s `evaluateDailyPlanRange` for the breakout/rejection gate they drive) and
`set_daily_take_profit_target` (a likely-move estimate, see `risk/stops.ts`'s
`DAILY_PLAN_TAKE_PROFIT_FRACTION`). When that fails and the scheduler's own built-in retry-once
also fails, the session trades with **zero daily-plan gate** until someone notices -- this
scheduler is deliberately fail-open (`dailyPlanScheduler.ts`'s own header comment), so it never
silently uses stale data, but it also never tells the operator it gave up beyond a log line.

Trigger phrases: "the daily plan/levels haven't populated", "set the daily plan manually",
"Gemini's out of quota, set it yourself", "why hasn't the [session] plan been built".

**This is a stopgap, not a redesign.** If the automated path is fine and you're just being asked
to do this once because it happened to fail right now, do this once and move on -- don't change
`dailyPlanScheduler.ts` itself unless the operator asks for that separately.

## Step 1: confirm the automated path actually failed, and why

```bash
docker exec teratrade-postgres psql -U teratrade -d teratrade -t -c "
SELECT symbol, price_low, price_high, label FROM daily_plan_zones
WHERE session_start = '<current session's start, UTC>' ORDER BY symbol;"
```

Empty result confirms nothing is set yet. Then check *why*:

```bash
grep -n "daily_plan_scheduler" backend/backend-dev.log | tail -10
```

The two failure modes seen live so far, worth telling apart because the fix/framing differs:

- **`RESOURCE_EXHAUSTED` / `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit 20**: the
  real *daily* Gemini quota is gone -- not recoverable by retrying, won't clear until Google's own
  reset. This is what this skill is for.
- **`RESOURCE_EXHAUSTED` / `GenerateContentInputTokensPerModelPerMinute-FreeTier`, limit 250000**:
  a *per-minute* token cap, usually from `assistant_messages` history bloat (every chat attempt,
  including failed ones, persists to history before calling Gemini -- see `assistant/client.ts`'s
  `sendChatMessageUnserialized`). This one IS recoverable: surgically delete orphaned digest
  messages (large `role='user'` rows with no `assistant` reply immediately after) and retry --
  don't reach for this skill's manual-set path first if a history cleanup would actually unblock
  the real automated path.
- **`UNAVAILABLE` / "high demand" (503)**: transient, Gemini's own retry logic usually clears it in
  under a minute. Don't manually intervene for a single 503 -- only act if the scheduler's own
  outer retry-once has also failed.

## Step 2: gather the exact same live data the assistant would have used

```bash
API_KEY=$(grep -m1 '^API_KEY=' backend/.env | cut -d= -f2-)
for ep in "market/snapshot" "market/support-resistance" "dealer-levels" "dealer-levels/report" "regime/current" "news/risk-status" "system/state" "analytics/session-performance"; do
  curl -s -H "x-api-key: $API_KEY" "http://localhost:8000/api/$ep"
done
```

These are the same 8 endpoints `dailyPlanScheduler.ts`'s `buildContextDigest` fetches -- read them
yourself rather than trusting stale numbers from earlier in the conversation, since price moves.

**Two real data-quality gotchas to check every time, confirmed live 2026-08-31:**

- **Dealer-gamma `spotPrice` can be stale** -- `dealerGexCache.ts` logs `dealer_gex_stale_spot_price`
  with a `staleForMs` when its own CBOE-derived spot hasn't moved recently (seen: ~95 minutes
  stale). The wall *levels themselves* (call wall, put wall, gamma flip) are still real and
  usable; just don't trust the narrative report's "spot is X points from this level" framing --
  recompute distance yourself against `market/snapshot`'s `lastPrice`, which reflects the real
  current bar close.
- **The `atrValue` in `market/support-resistance` can be degenerate** (seen: `0.0136` for ES,
  should be low single digits) -- if it's obviously not the right order of magnitude for the
  symbol, ignore it and lean on real touch-count clusters (`levels[].touches`) and the dealer
  wall levels instead.

## Step 3: pick the two boundaries and the likely-move estimate

Same judgment the assistant's prompt (`dailyPlanScheduler.ts`'s `buildRefreshPrompt`) asks for --
read that function for the exact current wording before writing anything, since it's the
authoritative description of the model and gets revised:

- **Support boundary** = the real, well-touched pivot (2+ touches ideally) or dealer put
  wall/gamma level nearest below current price that plausibly bounds today's range.
- **Resistance boundary** = same, nearest above. If price already broke through today's
  earlier-set resistance, the old resistance zone becoming the new support (and a fresh, further
  level becoming resistance) is the right read, not re-drawing tight bands around the last few
  minutes of tick congestion -- see `risk/engine.ts`'s `evaluateDailyPlanRange` for why direction
  matters here.
- Don't draw either boundary unrealistically tight (a 3-6pt band around current price) unless the
  regime genuinely is that quiet (check `regime/current`'s `volLabel`/`adx` first) -- the point is
  to bound where price can *realistically* range this session, not the last few ticks.
- **Likely-move estimate**: your own undiscounted read of a realistic achievable move, from the
  range width and regime strength. Don't pre-shrink it -- `DAILY_PLAN_TAKE_PROFIT_FRACTION`
  (currently 1/3, `risk/stops.ts`) is applied automatically downstream.

**Show the operator the computed numbers and get explicit confirmation before writing** -- this
is production risk-gate data on a live account, same bar as any other `risk/`-touching change.

## Step 4: write it, attributed consistently with a real assistant call

Writing directly to `daily_plan_zones`/`daily_plan_take_profit_targets` requires operator
approval -- expect the permission classifier to block a raw `docker exec`/`psql` write here; that
is not a bug, explain what you're about to write and let the operator approve it rather than
trying a different tool to route around the block.

```sql
DELETE FROM daily_plan_zones WHERE session_start = '<session_start>';
DELETE FROM daily_plan_take_profit_targets WHERE session_start = '<session_start>';

INSERT INTO daily_plan_zones (symbol, session_start, price_low, price_high, enforcement, label) VALUES
('ES', '<session_start>', <low>, <high>, 'hard', '<support label> [set by assistant -- manual, Gemini quota exhausted]'),
('ES', '<session_start>', <low>, <high>, 'hard', '<resistance label> [set by assistant -- manual, Gemini quota exhausted]'),
('NQ', '<session_start>', <low>, <high>, 'hard', '<support label> [set by assistant -- manual, Gemini quota exhausted]'),
('NQ', '<session_start>', <low>, <high>, 'hard', '<resistance label> [set by assistant -- manual, Gemini quota exhausted]');

INSERT INTO daily_plan_take_profit_targets (symbol, session_start, likely_move_points, label) VALUES
('ES', '<session_start>', <points>, '<reasoning> [set by assistant -- manual, Gemini quota exhausted]'),
('NQ', '<session_start>', <points>, '<reasoning> [set by assistant -- manual, Gemini quota exhausted]');
```

Also insert matching `assistant_actions` audit rows so this shows up in the Assistant Actions feed
exactly like a real automated cycle, not silently -- `enforcement` is always `'hard'` (the field is
a schema leftover, no longer read for the breakout/rejection decision, see `DailyPlanZone`'s own
comment in `risk/engine.ts`):

```sql
INSERT INTO assistant_actions (tool_name, input, status, result_summary, raw_result, created_at) VALUES
('set_daily_plan_zones', '<same JSON shape the real tool call would send>'::jsonb, 'success',
 'Set 2 daily plan zone(s) for ES this session. [Manually set by the assistant -- Gemini free-tier daily quota (20 requests) was exhausted, operator approved a manual set from the same live data the assistant would have used.]',
 '{"note":"quota-exhaustion fallback, same analytical basis as a normal assistant call"}'::jsonb, now());
-- repeat per symbol per tool (4 rows total: 2x set_daily_plan_zones, 2x set_daily_take_profit_target)
```

## Step 5: verify

```bash
curl -s -H "x-api-key: $API_KEY" "http://localhost:8000/api/daily-plan"
```

This is the same endpoint the dashboard's Daily Trading Plan panel (`frontend/components/
DailyPlanPanel.tsx`, on the main dashboard since 2026-08-31) reads -- confirm both symbols show
real boundaries, a sensible `status` (mid_range/testing_support/etc. against the *current* price,
not the price at write time), and non-null take-profit fields before calling it done.
