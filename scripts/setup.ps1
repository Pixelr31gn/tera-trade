# Tera Trade first-time setup.
# Run this once after extracting the package: installs dependencies for both
# backend and frontend, creates .env files, generates a real API key
# automatically, and walks you through connecting a free Neon database
# (there's no way to create that account for you -- Neon requires you to
# sign up -- but everything around that one manual step is automated).

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
    $apiKeyToShareWithFrontend = $newApiKey
} else {
    $apiKeyToShareWithFrontend = $currentApiKey
}

# --- Database: guide through Neon, since there's no account to automate around ---
$currentDbUrl = Get-EnvValue ".env" "DATABASE_URL"
if ($currentDbUrl -match "ep-example-12345") {
    Write-Host "`n--- Database setup ---" -ForegroundColor Cyan
    Write-Host "Opening Neon's project creation page in your browser (free tier, no card needed)."
    Write-Host "Create a project, then copy its connection string (Dashboard -> Connect -> the 'postgresql://...' string)."
    Start-Process "https://console.neon.tech/app/projects?modal=create-project"
    $pasted = Read-Host "`nPaste your Neon connection string here"
    if ($pasted) {
        Set-EnvValue ".env" "DATABASE_URL" $pasted
        Write-Host "Saved to backend\.env." -ForegroundColor Green

        Write-Host "Testing the connection and setting up the database schema..." -ForegroundColor Cyan
        npx prisma migrate deploy
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Could not connect/migrate -- double check the connection string (it should include ?sslmode=require) and re-run scripts\migrate.ps1 once fixed." -ForegroundColor Red
        } else {
            Write-Host "Database connected and schema is up to date." -ForegroundColor Green
        }
    } else {
        Write-Host "Skipped -- set DATABASE_URL in backend\.env yourself, then run scripts\migrate.ps1." -ForegroundColor Yellow
    }
} else {
    Write-Host "`nbackend\.env already has a DATABASE_URL set, leaving it as-is."
}
Pop-Location

Write-Host "`nInstalling frontend dependencies..." -ForegroundColor Cyan
Push-Location "$root\frontend"
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "frontend npm install failed" -ForegroundColor Red; Pop-Location; exit 1 }

if (-not (Test-Path ".env.local")) {
    Copy-Item ".env.example" ".env.local"
}
Set-EnvValue ".env.local" "NEXT_PUBLIC_API_KEY" $apiKeyToShareWithFrontend
Write-Host "frontend\.env.local's NEXT_PUBLIC_API_KEY set to match backend\.env's API_KEY automatically."
Pop-Location

Write-Host "`n=== Next steps ===" -ForegroundColor Cyan
$needsLicense = [string]::IsNullOrWhiteSpace((Get-EnvValue "$root\backend\.env" "LICENSE_KEY"))
if ($needsLicense) {
    Write-Host "1. You still need a license key -- see LICENSE.md, or ask whoever gave you this package for one." -ForegroundColor Yellow
    Write-Host "2. Run scripts\start.ps1 to launch the app."
} else {
    Write-Host "1. Run scripts\start.ps1 to launch the app."
}
Write-Host "See README.md for the full walkthrough."
