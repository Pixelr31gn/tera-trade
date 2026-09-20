---
name: launch
description: Start Tera Trade (backend + frontend) safely on a live-money system -- check for existing processes first, verify health, and work through the live-broker Chrome-connection dance if needed
---

Trigger phrase: "launch tera trade" / "start tera trade" / "launch tera" (typos included -- this
gets asked with a missing space or letter more often than not).

**This is a live-money trading system.** Never restart a process that's already healthy on a
vague instruction -- always check what's actually running first (`.claude/rules` and this
project's own feedback history both call this out: duplicate `tsx watch` processes have raced
for port 8000 before, and a restart mid-position is a real risk, not a hypothetical one).

## Step 1: check what's already running -- don't assume

```bash
netstat -ano | grep -E ":8000|:3000" | grep LISTENING
```

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*tera-trade*' } | Select-Object ProcessId, CommandLine
```

If both ports are already listening and healthy (Step 2 below passes), **say so and stop** --
there's nothing to launch. This has happened more than once: the user asks to "launch" when the
backend has been running unattended for hours.

Also check Postgres, since both processes need it:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

If `teratrade-postgres` isn't up, `docker start teratrade-postgres` (or `docker compose up -d`
from the repo root) before touching the app processes.

## Step 2: start whatever isn't running

```bash
cd backend && npm run dev > backend-dev.log 2>&1 &   # only if :8000 isn't listening
cd frontend && npm run dev > frontend-dev.log 2>&1 &  # only if :3000 isn't listening
```

Background these (`run_in_background: true` on the Bash tool) -- they're long-lived dev servers,
not one-shot commands. Don't touch whichever side is already healthy.

## Step 3: verify

```bash
API_KEY=$(grep -m1 '^API_KEY=' backend/.env | cut -d= -f2-)
curl -s http://localhost:8000/health
curl -s http://localhost:8000/api/system/state -H "x-api-key: $API_KEY"
curl -s -o /dev/null -w "frontend http %{http_code}\n" http://localhost:3000/
```

## Step 4: the live-broker gotcha (check this every time)

`liveBrokerConnected` in the system-state response is the one field worth reading closely.
`index.ts` only calls `liveBroker.connect()` **once**, at process boot -- if it fails, it stays
`false` for the rest of that process's life, no retry, by design (see `index.ts`'s own comment:
"LIVE mode unavailable until this is resolved, e.g. restart"). Two shapes this takes:

**Shape A -- Chrome is running but not logged in yet.** `liveBrokerConnected: false`, log shows
`matched_tab_not_authenticated` / `live_broker_connect_failed`. Tell the user to log into
TopstepX in the debug Chrome window (it auto-opens on backend startup -- see Step 5), then once
they confirm, restart *just the backend* to re-attempt the connection against the now-authenticated
tab. Don't touch Chrome itself; it's a separate, detached process (`chromeLauncher.ts` spawns it
`detached: true` + `unref()` specifically so a backend restart never kills the user's browser
session).

**Shape B -- the debug Chrome instance has actually closed** (port 9222 not listening at all --
`netstat -ano | grep 9222`). Happens after the machine sleeps/reboots or Chrome crashes. Restarting
the backend is enough on its own: `chromeLauncher.ts`'s `ensureDebugChromeRunning` auto-launches a
fresh debug Chrome (checked first via `isCdpResponding`, so it never spawns a duplicate if one's
already up) and navigates it to TopstepX. Then it's Shape A again -- wait for login, restart once
more.

Before any backend restart, always check for open positions and confirm you're only touching a
single instance (never assume there's just one, per Step 1):

```bash
curl -s http://localhost:8000/api/positions -H "x-api-key: $API_KEY"
```

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*tera-trade*backend*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <both PIDs: the tsx-watch supervisor AND its spawned node child> -Force
```

Then relaunch per Step 2's backend line.

## Step 5: the dashboard tab

`chromeLauncher.ts`'s `ensureDashboardTabOpen` (fire-and-forget, doesn't block startup) opens a
second tab in the same debug Chrome window pointed at `http://localhost:3000` once the frontend
dev server actually responds -- this should just happen on its own every time the debug Chrome
window opens; you shouldn't need to open it manually. It checks existing tabs first, so it won't
pile up duplicates across restarts/hot-reloads.

If it doesn't fire (log shows `dashboard_not_reachable_skipping_tab`), that's the frontend not
answering `http://localhost:3000` within `DASHBOARD_READY_TIMEOUT_MS` -- confirm the frontend is
actually up (Step 2/3) rather than assuming this file's own polling logic is broken; it was
widened 2026-08-11 (60s -> 180s poll budget, 2s -> 8s per-fetch timeout) specifically because a
busy cold-start backend was starving its own polling loop and spuriously giving up even when the
frontend was fine.

## What "done" looks like

- `/health` returns `{"status":"ok"}`.
- `/api/system/state` returns `liveBrokerConnected: true` (or you've explicitly told the user
  it's Shape A/B above and what they need to do next).
- Frontend responds 200.
- The debug Chrome window has both a TopstepX tab and a `localhost:3000` dashboard tab.
- No duplicate backend/frontend processes (re-run Step 1's process check).
