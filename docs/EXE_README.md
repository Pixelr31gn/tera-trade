# Tera Trade -- Setup Guide

This is the guide shipped inside the compiled `.exe` deliverable (see `scripts/build-exe.ps1`,
which copies this file into the zip as `README.md`). If you're reading this from the repo
instead, this describes the *packaged* experience -- running from source is different (see the
repo's own top-level README / `scripts/setup.ps1`).

## Prerequisites (one-time, before your first double-click)

1. **Docker Desktop** -- install it from [docker.com](https://www.docker.com/products/docker-desktop)
   and make sure it's running. Tera Trade's database (Postgres) runs in a container it manages
   for you -- you never interact with Docker directly beyond having it installed and open.
2. **Google Chrome** -- installed anywhere on the machine. You do **not** need to start it
   yourself or pass it any special flags -- the app finds and launches its own dedicated Chrome
   window automatically (see "Log into TopstepX" below).

## Step 1: extract the zip

Anywhere you like -- your Desktop, Documents, wherever. Keep the whole extracted folder
together; the two `.exe` files depend on the `app\`, `node\`, and `out\` folders sitting next to
them.

## Step 2 (first time only): double-click `tera-trade-setup.exe`

This does everything except the two things only you can provide:

- Creates `app\.env` from the template.
- Generates a real API key and database password automatically.
- Writes the license lines into `app\.env` for you (no longer checked by the app -- nothing to enter).
- Starts Postgres in Docker and waits for it to report healthy.
- Applies the database schema.
- If this package includes a database snapshot (`app\db-seed.dump`), restores it automatically
  into the fresh database -- your scores, trades, and equity history from the machine this
  package was built on are already there, no re-collecting data from scratch. Only happens once,
  against a genuinely empty database; running setup again later never overwrites data that's
  already there.

When it prints "Setup complete!", you're done -- you won't need to run this again unless you
delete `app\.env` and want to start fresh.

## Step 3 (every time after): double-click `tera-trade.exe`

- Starts the backend.
- Serves the dashboard and opens it in your browser automatically at `http://localhost:3000`.
- Leave this console window open while you're using the app -- closing it (or Ctrl+C inside it)
  stops the backend and dashboard together, cleanly.

## One more one-time step: log into TopstepX

Tera Trade reads your real TopstepX account (and, once you enable it, places real orders) by
driving its own dedicated Chrome window -- not your everyday browser. The first time
`tera-trade.exe` runs, it opens a Chrome window pointed at `topstepx.com`.

- Log in there once, as you normally would.
- That session is saved to a private profile the app manages
  (`%LOCALAPPDATA%\TeraTrade\chrome-debug-profile`) -- you won't need to log in again on later
  launches.
- **Leave that Chrome window open** in the background while `tera-trade.exe` is running --
  closing it stops the app from reading your account or placing orders.

## This build is live by default -- read this before your first launch

Unlike earlier Tera Trade packages, **this one ships already configured for real trading**:
`TRADING_MODE=live`, `BROKER_KIND=browser_control`, `LIVE_TRADING_CONFIRMED=true`, and
`DRY_RUN_ORDERS=false` are all set in `app\.env` from the moment setup finishes. There is no
separate "going live" step -- the first qualifying signal after you log into TopstepX and
`tera-trade.exe` starts will click a real Buy/Sell button on your real account.

If you'd rather watch it first, close `tera-trade.exe`, open `app\.env` in a text editor
(Notepad works fine), and either:

- Set `TRADING_MODE=paper` (and `BROKER_KIND=simulated`) to score real signals against the live
  market without ever placing a real order, or
- Leave `TRADING_MODE=live` but set `DRY_RUN_ORDERS=true` -- every step short of the final
  Buy/Sell/Close click still happens for real against your account (the right instrument and
  quantity are found), but the click itself only highlights the button instead of pressing it.

Save the file, then double-click `tera-trade.exe` again. Flip the same flags back to go live for
real once you trust what you're seeing.

## Troubleshooting

- **"docker compose up failed" during setup**: Docker Desktop isn't installed or isn't running.
  Start it, then re-run `tera-trade-setup.exe` -- it's safe to run more than once.
- **"Postgres didn't report healthy in time"**: check `docker compose logs` from inside the
  extracted folder, or just re-run `tera-trade-setup.exe` again.
- **The backend window opens and immediately closes**: read the last lines it printed before
  closing -- most often the database isn't reachable (is Docker Desktop running?) or a value
  in `app\.env` is malformed. (A missing or invalid license key can no longer cause this;
  the license check was removed 2026-09-20.)
- **Dashboard loads but shows no account data**: make sure the TopstepX Chrome window from
  "Log into TopstepX" above is still open and you're actually logged in there.

## Stopping the app

Close the `tera-trade.exe` console window (or press Ctrl+C inside it) -- this stops the
dashboard and backend together. The TopstepX Chrome window is independent and can be closed or
left open separately.
