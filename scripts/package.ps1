# Builds a clean, distributable tera-trade-<version>.zip -- source only, no
# node_modules/.git/build output/logs, and critically NO .env files (those
# hold your real DATABASE_URL, LICENSE_SIGNING_SECRET, and API keys --
# shipping them would leak your secrets to whoever gets the zip).
#
# Usage: scripts\package.ps1 [outputDir] [version]
#   outputDir defaults to the parent of the repo, version defaults to "1.1".

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = if ($args.Count -ge 2) { $args[1] } else { "1.1" }
$stagingDir = Join-Path $env:TEMP "tera-trade-package-staging"
$outputDir = if ($args.Count -ge 1) { $args[0] } else { "$root\.." }
$zipPath = Join-Path $outputDir "tera-trade-$version.zip"

if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
New-Item -ItemType Directory -Path $stagingDir | Out-Null

Write-Host "Staging a clean copy..." -ForegroundColor Cyan
robocopy $root $stagingDir /E `
    /XD node_modules .git .next dist dist-launcher dist-setup-exe dist-launcher-exe .claude `
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

# Source-only should be a few MB at most -- a much bigger zip almost always
# means something that doesn't belong got swept in by robocopy (2026-07-20:
# a stray Chrome debug profile someone had accidentally pointed at the repo
# root itself ballooned this to 19MB+, silently, until someone happened to
# notice). Not a hard failure since a real reason could exist -- just a loud
# nudge to go check `Compress-Archive -Path "$stagingDir\*"`'s actual
# contents before handing the zip to anyone.
if ($sizeMb -gt 10) {
    Write-Host "WARNING: that's larger than expected for source-only. Double check nothing unexpected (e.g. a misplaced browser profile, stray data files) got included before distributing this." -ForegroundColor Yellow
}
