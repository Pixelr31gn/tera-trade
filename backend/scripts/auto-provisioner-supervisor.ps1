# Keeps the Auto-Provisioner running continuously -- relaunches it immediately if it ever exits,
# for any reason. Mirrors scout-supervisor.ps1's own reasoning exactly; see that file's header
# comment. Sets AUTO_PROVISIONER_ENABLED itself, in-process -- backend/.env is never written by
# this (CLAUDE.md's "never modify .env" rule).

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$backendDir = Split-Path -Parent $PSScriptRoot
Set-Location $backendDir

$env:AUTO_PROVISIONER_ENABLED = 'true'

$logDir = Join-Path $backendDir '.scout-state'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'auto-provisioner-supervisor.log'

while ($true) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] starting auto-provisioner" -Encoding utf8
    & npx tsx src/autoProvisioner/run.ts 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] auto-provisioner exited (code $LASTEXITCODE), restarting in 10s" -Encoding utf8
    Start-Sleep -Seconds 10
}
