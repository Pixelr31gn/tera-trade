# Tera Trade first-time setup.
# Run this once after extracting the package: installs dependencies for both
# backend and frontend, creates .env files, generates a real API key and a
# real Postgres password automatically, and spins up your own local Postgres
# in Docker -- no hosted database account needed anywhere.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Test-CommandExists($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Set-EnvValue($path, $key, $value) {
    $content = Get-Content $path
    $pattern = "^$key="
    if ($content -match $pattern) {
        $content = $content -replace "$pattern.*", "$key=$value"
    } else {
        $content += "$key=$value"
    }
    Set-Content -Path $path -Value $content
}

function Get-EnvValue($path, $key) {
    $line = Get-Content $path | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    if (-not $line) { return "" }
    return ($line -split "=", 2)[1]
}

Write-Host "=== Tera Trade setup ===" -ForegroundColor Cyan

if (-not (Test-CommandExists "node")) {
    Write-Host "Node.js was not found on PATH. Install Node.js 20+ from https://nodejs.org and re-run this script." -ForegroundColor Red
    exit 1
}
Write-Host "Found Node.js $(node --version)"

$chromeCandidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)
if (-not ($chromeCandidates | Where-Object { Test-Path $_ })) {
    Write-Host "Google Chrome was not found in its usual install location. The app can still run, but you'll need to set CHROME_EXECUTABLE_PATH in backend\.env, or install Chrome from https://google.com/chrome." -ForegroundColor Yellow
}

if (-not (Test-CommandExists "docker")) {
    Write-Host "Docker was not found on PATH. Tera Trade runs its own local Postgres database in Docker -- install Docker Desktop from https://www.docker.com/products/docker-desktop, make sure it's running, and re-run this script." -ForegroundColor Red
    exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker is installed but doesn't seem to be running. Start Docker Desktop and re-run this script." -ForegroundColor Red
    exit 1
}
Write-Host "Found Docker $(docker --version)"

Write-Host "`nInstalling backend dependencies..." -ForegroundColor Cyan
Push-Location "$root\backend"
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "backend npm install failed" -ForegroundColor Red; Pop-Location; exit 1 }

$backendEnvIsNew = -not (Test-Path ".env")
if ($backendEnvIsNew) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created backend\.env from the template."
} else {
    Write-Host "backend\.env already exists, leaving values you've already set as-is."
}

# --- API key: generate a real one instead of leaving the shared placeholder ---
$currentApiKey = Get-EnvValue ".env" "API_KEY"
if ([string]::IsNullOrWhiteSpace($currentApiKey) -or $currentApiKey -eq "change-me-dev-key") {
    # RNGCryptoServiceProvider (not [Convert]::ToHexString, which needs
    # PowerShell 7+/.NET 5+ and isn't available on the Windows PowerShell
    # 5.1 most people actually have) for a cryptographically random key.
    $randomBytes = New-Object byte[] 24
    (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($randomBytes)
    $newApiKey = ($randomBytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-EnvValue ".env" "API_KEY" $newApiKey
    Write-Host "Generated a real API_KEY (was the shared placeholder)." -ForegroundColor Green
}

# --- Database: your own local Postgres in Docker, no hosted account needed ---
$rootEnvPath = "$root\.env"
if (-not (Test-Path $rootEnvPath)) {
    Copy-Item "$root\.env.example" $rootEnvPath
    Write-Host "Created .env (repo root) from the template."
}
$currentPgPassword = Get-EnvValue $rootEnvPath "POSTGRES_PASSWORD"
if ([string]::IsNullOrWhiteSpace($currentPgPassword) -or $currentPgPassword -eq "change-me") {
    $randomBytes = New-Object byte[] 24
    (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($randomBytes)
    $pgPassword = ($randomBytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-EnvValue $rootEnvPath "POSTGRES_PASSWORD" $pgPassword
    Write-Host "Generated a real POSTGRES_PASSWORD (was the shared placeholder)." -ForegroundColor Green
} else {
    $pgPassword = $currentPgPassword
}

Write-Host "`n--- Database setup ---" -ForegroundColor Cyan
Write-Host "Starting local Postgres in Docker..." -ForegroundColor Cyan
docker compose -f "$root\docker-compose.yml" --env-file $rootEnvPath up -d
if ($LASTEXITCODE -ne 0) { Write-Host "docker compose up failed -- see the error above." -ForegroundColor Red; Pop-Location; exit 1 }

Write-Host "Waiting for Postgres to become healthy..."
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    $status = docker inspect --format='{{.State.Health.Status}}' teratrade-postgres 2>$null
    if ($status -eq "healthy") { $healthy = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $healthy) {
    Write-Host "Postgres didn't report healthy in time -- check 'docker compose logs' in the repo root." -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "Postgres is up." -ForegroundColor Green

Set-EnvValue ".env" "DATABASE_URL" "postgresql://teratrade:$pgPassword@localhost:5432/teratrade?schema=public"
Write-Host "Set DATABASE_URL in backend\.env to the local container."

Write-Host "Applying database schema..." -ForegroundColor Cyan
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) {
    Write-Host "Migration failed -- see the error above. Re-run scripts\migrate.ps1 once fixed." -ForegroundColor Red
} else {
    Write-Host "Database schema is up to date." -ForegroundColor Green
}
Pop-Location

Write-Host "`nInstalling frontend dependencies..." -ForegroundColor Cyan
Push-Location "$root\frontend"
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "frontend npm install failed" -ForegroundColor Red; Pop-Location; exit 1 }

if (-not (Test-Path ".env.local")) {
    Copy-Item ".env.example" ".env.local"
    Write-Host "Created frontend\.env.local from the template."
}
# No NEXT_PUBLIC_API_KEY step any more: the dashboard signs in with a password
# and an httpOnly session cookie (see frontend/lib/api.ts), and a key baked
# into the browser bundle would be readable by anyone. This script used to copy
# backend\.env's API_KEY into .env.local here; nothing reads it any more.
Pop-Location

# --- Dashboard login password ---------------------------------------------
# Login is refused (fails closed) until AUTH_PASSWORD_HASH is set, so without
# this the dashboard loads but nobody can ever sign in. `auth:set-password`
# prompts for the password with masked input and writes only its hash (plus a
# session secret) into backend\.env. Interactive, so it needs a real console.
Push-Location "$root\backend"
if ([string]::IsNullOrWhiteSpace((Get-EnvValue ".env" "AUTH_PASSWORD_HASH"))) {
    Write-Host "`n--- Dashboard password ---" -ForegroundColor Cyan
    Write-Host "Choose the password you'll use to sign in to the dashboard (min 8 characters)."
    npm run auth:set-password
    if ($LASTEXITCODE -ne 0) {
        Write-Host "No dashboard password was set. Run 'npm run auth:set-password' in backend\ before you try to sign in." -ForegroundColor Yellow
    }
} else {
    Write-Host "`nDashboard password already set in backend\.env, leaving it as-is."
}
Pop-Location

Write-Host "`n=== Next steps ===" -ForegroundColor Cyan
# The license-key step that used to be listed here was removed 2026-09-20 --
# the app no longer checks for a key (see the note at the top of backend/src/index.ts).
Write-Host "1. Run scripts\start.ps1 to launch the app."
Write-Host "2. In the Chrome window that opens, log into TopstepX (once -- it's remembered)."
Write-Host "3. Open http://localhost:3000 and sign in with the dashboard password you just set."
Write-Host "Tera Trade starts in PAPER mode (a simulated account, no real orders). See README.md, 'Trading modes'."
