# Updates an existing Tera Trade checkout to the latest build: pulls the newest
# code, refreshes dependencies, and applies any new database migrations.
#
# Run it from the repo root with Tera Trade STOPPED (close the backend and
# dashboard windows first):
#     powershell -ExecutionPolicy Bypass -File scripts\update.ps1
#
# It never touches your .env files or your data. `git pull --ff-only` only ever
# moves your checkout forward -- if you've edited tracked files in a way that
# conflicts with an update, git refuses and this script stops before changing
# anything else, so nothing of yours is overwritten.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Fail($message) {
    Write-Host $message -ForegroundColor Red
    exit 1
}

Write-Host "=== Tera Trade update ===" -ForegroundColor Cyan

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git was not found on PATH. Install it from https://git-scm.com and re-run." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found on PATH. Install Node.js 20+ from https://nodejs.org and re-run." }
if (-not (Test-Path "$root\.git")) { Fail "$root is not a git checkout, so there's nothing to pull. (If you installed from the packaged .exe instead, updates come as a new download.)" }

# Windows keeps Prisma's native query-engine file locked while the backend
# runs, which makes `prisma generate` fail with EPERM partway through an
# update -- and an update while the app is live could swap code out from under
# a running process. So: stopped means stopped.
foreach ($port in 8000, 3000) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Fail "Something is still listening on port $port -- Tera Trade looks like it's running. Close the backend and dashboard windows, then re-run this script."
    }
}

Push-Location $root
try {
    $before = (git rev-parse --short HEAD).Trim()
    Write-Host "`nCurrent version: $before ($((git rev-parse --abbrev-ref HEAD).Trim()))"

    Write-Host "Pulling the latest code..." -ForegroundColor Cyan
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Fail "git pull failed (see above). Nothing else was changed. Usually this means you've edited a tracked file that the update also changes -- commit or stash your edits, or ask whoever maintains this repo."
    }

    $after = (git rev-parse --short HEAD).Trim()
    if ($before -eq $after) {
        Write-Host "Already on the latest version ($after)." -ForegroundColor Green
    } else {
        Write-Host "Updated $before -> $after. What changed:" -ForegroundColor Green
        git log --oneline "$before..$after"
    }

    Write-Host "`nUpdating backend dependencies..." -ForegroundColor Cyan
    Push-Location "$root\backend"
    npm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "backend npm install failed -- see above." }
    npx prisma generate
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "prisma generate failed -- see above. If it says EPERM, something still has the backend's files open; close it and re-run." }
    Pop-Location

    Write-Host "`nUpdating dashboard dependencies..." -ForegroundColor Cyan
    Push-Location "$root\frontend"
    npm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "dashboard npm install failed -- see above." }
    Pop-Location

    # Migrations need the database up. `up -d` is a no-op if it already is.
    $rootEnv = "$root\.env"
    if ((Test-Path $rootEnv) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "`nMaking sure local Postgres is running..." -ForegroundColor Cyan
        docker compose -f "$root\docker-compose.yml" --env-file $rootEnv up -d
        if ($LASTEXITCODE -ne 0) { Fail "Could not start the local Postgres container -- is Docker Desktop running?" }
        $healthy = $false
        for ($i = 0; $i -lt 30; $i++) {
            $status = docker inspect --format='{{.State.Health.Status}}' teratrade-postgres 2>$null
            if ($status -eq "healthy") { $healthy = $true; break }
            Start-Sleep -Seconds 2
        }
        if (-not $healthy) { Fail "Postgres didn't report healthy in time -- check 'docker compose logs' in the repo root." }
    }

    Write-Host "`nApplying any new database migrations..." -ForegroundColor Cyan
    Push-Location "$root\backend"
    npx prisma migrate deploy
    $migrateExit = $LASTEXITCODE
    Pop-Location
    if ($migrateExit -ne 0) { Fail "Migration failed -- check DATABASE_URL in backend\.env and that the database is reachable. The code and dependencies ARE updated; re-run scripts\migrate.ps1 once that's fixed." }
}
finally {
    Pop-Location
}

Write-Host "`n=== Update complete ===" -ForegroundColor Green
Write-Host "Start Tera Trade again with scripts\start.ps1."
Write-Host "New releases can add settings; every one has a default, so your backend\.env keeps working. Compare it with backend\.env.example if you want to see what's new."
