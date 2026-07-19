# Applies the database schema to whatever DATABASE_URL points at in
# backend\.env. Run this once after filling in .env, and again after
# pulling any future update that includes new migrations.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Push-Location "$root\backend"
if (-not (Test-Path ".env")) {
    Write-Host "backend\.env not found -- run scripts\setup.ps1 first, then fill in DATABASE_URL." -ForegroundColor Red
    Pop-Location
    exit 1
}
npx prisma migrate deploy
$exitCode = $LASTEXITCODE
Pop-Location
if ($exitCode -ne 0) {
    Write-Host "Migration failed -- check DATABASE_URL in backend\.env is correct and the database is reachable." -ForegroundColor Red
    exit 1
}
Write-Host "Database schema is up to date." -ForegroundColor Green
