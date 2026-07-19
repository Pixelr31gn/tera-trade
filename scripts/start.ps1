# Launches the backend and frontend, each in its own window so you can see
# their logs directly. Close either window to stop that half of the app.

$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$root\backend\.env")) {
    Write-Host "backend\.env not found -- run scripts\setup.ps1 first, fill in .env, then scripts\migrate.ps1." -ForegroundColor Red
    exit 1
}

Write-Host "Starting backend (new window)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; npm run dev"

Start-Sleep -Seconds 3

Write-Host "Starting frontend (new window)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev"

Write-Host "`nBackend:   http://localhost:8000/health" -ForegroundColor Green
Write-Host "Dashboard: http://localhost:3000" -ForegroundColor Green
Write-Host "`nOn first run, a dedicated Chrome window opens automatically -- log into TopstepX in it once." -ForegroundColor Yellow
