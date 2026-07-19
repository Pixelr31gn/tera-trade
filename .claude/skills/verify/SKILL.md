---
name: verify
description: How to verify a tera-trade change against the actual running app (not tests/typecheck)
---

Tera Trade's backend and frontend are usually **already running** as long-lived dev
processes (`tsx watch` / `next dev`), not something you launch fresh per verification.

## Find the running processes

```bash
netstat -ano | grep -E ":8000|:3000" | grep LISTENING   # backend : frontend
```

Logs are plain files in each app dir: `backend/backend-dev.log`, `frontend/frontend-dev.log`
(both gitignored, rotate over time). `tsx watch` auto-restarts the backend on every saved
file change — check the log for `fatal_startup_error`/`EADDRINUSE` after an edit before
assuming it picked the change up cleanly.

**Never assume there's only one instance.** This repo has had two duplicate `tsx watch`
backend processes running simultaneously for hours (started at different times, silently
racing for port 8000). Before trusting `netstat`'s single LISTENING line, check for
stragglers: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
$_.CommandLine -like '*tera-trade*backend*' }` (PowerShell) — every match should trace back
to the one supervisor you expect.

**Live-money caution**: the backend may be running against the user's real TopstepX
account. Read `/api/system/state` (mode + `liveBrokerConnected`) and `/api/positions`
before doing anything that touches the process (restart, kill) — never do so on a vague
instruction; get explicit confirmation naming the live process first.

## Drive the backend (the real surface for engine/risk/scoring changes)

```bash
API_KEY=$(grep -m1 '^API_KEY=' backend/.env | cut -d= -f2-)
curl -s http://localhost:8000/health
curl -s http://localhost:8000/api/system/state -H "x-api-key: $API_KEY"
curl -s "http://localhost:8000/api/trades?limit=20" -H "x-api-key: $API_KEY"
curl -s "http://localhost:8000/api/recommendations?limit=300" -H "x-api-key: $API_KEY"
```

The engine loop only ticks on real bars/timers, so the fastest way to observe a scoring/
risk/execution change is the **live log**, not a synthetic API call — grep for the event
names it actually emits:

```bash
grep -E "consensus_reached|consensus_not_reached|risk_rejected|trade_opened|kill_switch_tripped|continuous_scan_failed" backend/backend-dev.log | tail -30
```

`consensus_reached`/`risk_rejected` lines include a `reason`/`summary` field with the exact
factor math — that's real evidence a rule change is behaving as coded, not just that it
compiles. Cross-check against `/api/trades` for the resulting trade's `pnl`/`exitReason` to
confirm a full signal → consensus → risk → execution → close cycle.

## Drive the frontend

`next dev`'s pages are `"use client"` and fetch via SWR **after** mount — curling the page
HTML only shows the pre-fetch loading shell, not real data. To verify a UI change actually
works end-to-end without a browser-automation tool available:

1. Confirm the page/route serves clean: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/<route>`
2. Confirm the exact API call the component makes returns the shape it expects (read the
   component source for the SWR key, then curl that exact URL+params against :8000).
3. `grep -iE "error|exception|failed to compile" frontend/frontend-dev.log` — empty is a real
   signal (Next.js logs client-reported errors and compile failures here).
4. For a genuine pixel-level check, none of the above substitutes for actually opening the
   page in a browser — say so explicitly rather than claiming a visual PASS you didn't see.

## Common gotchas

- Prisma's query engine DLL is locked by whichever backend process is running --
  `npx prisma generate` fails with `EPERM` while it's up. Only regenerate after stopping it,
  or skip it for index-only schema changes (no Client API surface change).
- `SystemState.mode` (paper/live/analysis_only) is a DB-persisted runtime toggle, independent
  of the `.env` `TRADING_MODE` value -- always read the live `/api/system/state`, never infer
  mode from `.env`.
