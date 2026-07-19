# Builds a clean, distributable tera-trade.zip -- source only, no
# node_modules/.git/build output/logs, and critically NO .env files (those
# hold your real DATABASE_URL, LICENSE_SIGNING_SECRET, and API keys --
# shipping them would leak your secrets to whoever gets the zip).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stagingDir = Join-Path $env:TEMP "tera-trade-package-staging"
$outputDir = if ($args.Count -ge 1) { $args[0] } else { "$root\.." }
$zipPath = Join-Path $outputDir "tera-trade.zip"

if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
New-Item -ItemType Directory -Path $stagingDir | Out-Null

Write-Host "Staging a clean copy..." -ForegroundColor Cyan
robocopy $root $stagingDir /E `
    /XD node_modules .git .next dist .claude `
    /XF ".env" ".env.local" ".env.*.local" "*.log" "*.tsbuildinfo" `
    /NFL /NDL /NJH /NJS | Out-Null
# robocopy's exit codes 0-7 are all "success" (8+ means real errors) --
# PowerShell treats any non-zero $LASTEXITCODE as failure by default, so
# check explicitly rather than relying on $?.
if ($LASTEXITCODE -ge 8) {
    Write-Host "robocopy failed (exit code $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

# Double-check no real env file slipped through (defense in depth -- this is
# the one mistake that actually matters here). Matches any ".env*" EXCEPT
# ".env.example", by name rather than trying to enumerate every possible
# variant (.env.local, .env.development, etc.) up front in the robocopy
# exclude list above.
$leakedEnvFiles = Get-ChildItem -Path $stagingDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like ".env*" -and $_.Name -ne ".env.example" }
if ($leakedEnvFiles) {
    Write-Host "REFUSING TO PACKAGE: found real env file(s) in the staged copy:" -ForegroundColor Red
    $leakedEnvFiles | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Red }
    Remove-Item -Recurse -Force $stagingDir
    exit 1
}

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Write-Host "Compressing to $zipPath ..." -ForegroundColor Cyan
Compress-Archive -Path "$stagingDir\*" -DestinationPath $zipPath -CompressionLevel Optimal

Remove-Item -Recurse -Force $stagingDir

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "`nBuilt $zipPath ($sizeMb MB)" -ForegroundColor Green
Write-Host "Contains no node_modules, no .git history, no .env files -- recipient runs scripts\setup.ps1 after extracting." -ForegroundColor Green
