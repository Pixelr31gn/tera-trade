# Keeps the Cross-Regime Analyzer running continuously -- relaunches it immediately if it ever
# exits, for any reason. Same reasoning as scout-supervisor.ps1/taylor-supervisor.ps1; see those
# files' own header comments. Sets CROSS_REGIME_ENABLED itself, in-process -- backend/.env is never
# written by this (CLAUDE.md's "never modify .env" rule, narrowed 2026-09-10 to still exclude
# blanket automated edits like this one).

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$backendDir = Split-Path -Parent $PSScriptRoot
Set-Location $backendDir

$env:CROSS_REGIME_ENABLED = 'true'

$logDir = Join-Path $backendDir '.scout-state'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'cross-regime-supervisor.log'

while ($true) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] starting cross-regime analyzer" -Encoding utf8
    & npx tsx src/crossRegimeAnalyzer/run.ts 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] cross-regime analyzer exited (code $LASTEXITCODE), restarting in 10s" -Encoding utf8
    Start-Sleep -Seconds 10
}
