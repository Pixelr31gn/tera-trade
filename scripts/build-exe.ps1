# Builds the Tera Trade 1.4+ compiled .exe deliverable -- a genuine 2-click
# setup, distinct from scripts\package.ps1's existing source-zip deliverable
# (used for v1.1-v1.3). Docker Desktop stays a one-time, manual prerequisite
# (same as every other Tera Trade distribution) -- everything else is
# automated into exactly two double-clicks:
#   1. tera-trade-setup.exe -- one-time: creates .env (prompts only for the
#      license key), starts Docker Compose, runs the database migrations.
#   2. tera-trade.exe -- every time after: starts the backend and serves the
#      dashboard together, opens your browser to it automatically.
#
# Architecture (see scripts\exe-launcher.cjs's header comment for the full
# "why" -- both `pkg` and a fully-SEA-embedded single-file bundle are
# confirmed dead ends for this dependency stack, 2026-07-29):
#   - Both exes are Node SEA-compiled from dependency-free CJS scripts
#     (scripts\exe-setup.cjs, scripts\exe-launcher.cjs -- only Node builtins:
#     child_process, http, fs, path, crypto, readline). Neither embeds
#     Prisma or Playwright at all -- the launcher spawns the real backend as
#     a completely normal, separate `node.exe app\dist\index.js` process
#     against a portable, unmodified `app\` folder (real dist\ +
#     node_modules\), so both work exactly as they do outside packaging.
#   - Chrome remains external in both cases -- see docs/BROWSER_WATCH.md.
#
# Usage: scripts\build-exe.ps1 [outputDir] [version]
#   outputDir defaults to the parent of the repo, version defaults to "1.4.0".

# Deliberately NOT $ErrorActionPreference = "Stop" globally -- `node` and
# `npx postject` both write informational lines to stderr on success (e.g.
# "Wrote single executable preparation blob to ..."), and PowerShell wraps
# any native command's stderr output in a terminating ErrorRecord under
# "Stop", failing the script even on a real success. Every native command
# below is followed by its own explicit $LASTEXITCODE check instead, which
# is the actually-reliable signal.
$root = Split-Path -Parent $PSScriptRoot
$version = if ($args.Count -ge 2) { $args[1] } else { "1.4.0" }
$outputDir = if ($args.Count -ge 1) { $args[0] } else { "$root\.." }

# Timestamped, not a fixed name -- a previous run's staged .exe can still be
# locked by a lingering process/AV scan for a bit after it's done running,
# and a fixed staging dir would then fail to clean up on the next build. A
# fresh directory every run sidesteps that entirely instead of depending on
# being able to delete the old one.
$stagingDir = Join-Path $env:TEMP "tera-trade-exe-staging-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$deliverableName = "tera-trade-$version-exe"
$deliverableDir = Join-Path $stagingDir $deliverableName

New-Item -ItemType Directory -Path $deliverableDir -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path "$deliverableDir\node" -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path "$deliverableDir\app" -ErrorAction Stop | Out-Null

$nodeExePath = (Get-Command node).Source
Write-Host "Using Node runtime: $nodeExePath" -ForegroundColor Cyan

function Build-SeaExe($mainScript, $seaWorkDir, $outputExeName) {
    if (Test-Path $seaWorkDir) { Remove-Item -Recurse -Force $seaWorkDir }
    New-Item -ItemType Directory -Path $seaWorkDir -ErrorAction Stop | Out-Null
    $mainEscaped = $mainScript.Replace('\', '\\')
    $blobPath = (Join-Path $seaWorkDir "sea-prep.blob").Replace('\', '\\')
    @"
{
  "main": "$mainEscaped",
  "output": "$blobPath",
  "disableExperimentalSEAWarning": true
}
"@ | Out-File -Encoding utf8 (Join-Path $seaWorkDir "sea-config.json")
    # *> $null (not just redirecting stdout) suppresses stderr too -- without
    # it, PowerShell folds every line these native commands print (including
    # postject's own "Start injection..."/"Injection done!" stderr chatter)
    # into THIS FUNCTION'S OWN RETURN VALUE, since unredirected output inside
    # a function is captured as part of its output stream. Confirmed live:
    # $exePath came back polluted with literal console text instead of a
    # clean path the one time this wasn't suppressed.
    node --experimental-sea-config (Join-Path $seaWorkDir "sea-config.json") *> $null
    if ($LASTEXITCODE -ne 0) { throw "SEA blob generation failed for $mainScript" }
    $exePath = Join-Path $seaWorkDir $outputExeName
    Copy-Item $nodeExePath $exePath -ErrorAction Stop
    npx postject $exePath NODE_SEA_BLOB (Join-Path $seaWorkDir "sea-prep.blob") --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 *> $null
    if ($LASTEXITCODE -ne 0) { throw "postject injection failed for $mainScript" }
    return $exePath
}

# --- Backend ---
Write-Host "`nBuilding backend..." -ForegroundColor Cyan
Push-Location "$root\backend"
npm run build
if ($LASTEXITCODE -ne 0) { throw "backend build failed" }

Write-Host "Staging portable backend app folder..." -ForegroundColor Cyan
Copy-Item "$root\backend\dist" "$deliverableDir\app\dist" -Recurse -ErrorAction Stop
Copy-Item "$root\backend\package.json" "$deliverableDir\app\package.json" -ErrorAction Stop
Copy-Item "$root\backend\node_modules" "$deliverableDir\app\node_modules" -Recurse -ErrorAction Stop
Copy-Item $nodeExePath "$deliverableDir\node\node.exe" -ErrorAction Stop

# `prisma/schema.prisma` + `prisma/migrations/` -- without these, the bundled
# Prisma CLI (node_modules/prisma, already copied above) has nothing to tell
# it what schema to apply, so a fresh recipient Postgres would never get its
# tables created at all. `docker-compose.yml` -- so tera-trade-setup.exe can
# stand up local Postgres the exact same way scripts\setup.ps1 already does.
Copy-Item "$root\backend\prisma" "$deliverableDir\app\prisma" -Recurse -ErrorAction Stop
Copy-Item "$root\docker-compose.yml" "$deliverableDir\docker-compose.yml" -ErrorAction Stop
Copy-Item "$root\backend\.env.example" "$deliverableDir\.env.example" -ErrorAction Stop
Copy-Item "$root\docs\EXE_README.md" "$deliverableDir\README.md" -ErrorAction Stop
Pop-Location

# --- Frontend (static export) ---
Write-Host "`nBuilding frontend (static export)..." -ForegroundColor Cyan
Push-Location "$root\frontend"
npm run build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
Copy-Item "$root\frontend\out" "$deliverableDir\out" -Recurse -ErrorAction Stop
Pop-Location

# --- The two exes ---
Write-Host "`nCompiling tera-trade-setup.exe (Node SEA)..." -ForegroundColor Cyan
$setupExe = Build-SeaExe "$root\scripts\exe-setup.cjs" "$root\scripts\dist-setup-exe" "tera-trade-setup.exe"
Copy-Item $setupExe "$deliverableDir\tera-trade-setup.exe" -ErrorAction Stop

Write-Host "Compiling tera-trade.exe (Node SEA)..." -ForegroundColor Cyan
$launcherExe = Build-SeaExe "$root\scripts\exe-launcher.cjs" "$root\scripts\dist-launcher-exe" "tera-trade.exe"
Copy-Item $launcherExe "$deliverableDir\tera-trade.exe" -ErrorAction Stop

# Refuse to ship a real .env (same safety check as scripts\package.ps1).
$leakedEnvFiles = Get-ChildItem -Path $deliverableDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like ".env*" -and $_.Name -ne ".env.example" }
if ($leakedEnvFiles) {
    Write-Host "REFUSING TO PACKAGE: found real env file(s) in the staged copy:" -ForegroundColor Red
    $leakedEnvFiles | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Red }
    Remove-Item -Recurse -Force $stagingDir
    exit 1
}

# --- Zip it up ---
$zipPath = Join-Path $outputDir "$deliverableName.zip"
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Write-Host "`nCompressing to $zipPath ..." -ForegroundColor Cyan
Compress-Archive -Path "$deliverableDir\*" -DestinationPath $zipPath -CompressionLevel Optimal -ErrorAction Stop

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "`nBuilt $zipPath ($sizeMb MB)" -ForegroundColor Green
Write-Host "`nRecipient setup (2 clicks after installing Docker Desktop + Chrome once):" -ForegroundColor Green
Write-Host "  1. Install Docker Desktop (if not already) and Google Chrome." -ForegroundColor Green
Write-Host "  2. Extract the zip." -ForegroundColor Green
Write-Host "  3. Double-click tera-trade-setup.exe -- prompts for the license key, does everything else automatically." -ForegroundColor Green
Write-Host "  4. Double-click tera-trade.exe -- starts the app and opens the dashboard." -ForegroundColor Green
Write-Host "  (One-time, separate from the 2 clicks: log into TopstepX in the Chrome window the app opens -- see docs/BROWSER_WATCH.md.)" -ForegroundColor Green
