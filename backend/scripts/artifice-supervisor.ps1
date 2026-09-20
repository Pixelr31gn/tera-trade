# Keeps Artifice running continuously -- relaunches it immediately if it ever exits, for any
# reason (crash, an unreachable Ollama host, etc.). Same reasoning as scout-supervisor.ps1/
# taylor-supervisor.ps1; see those files' own header comments. Sets ARTIFICE_ENABLED itself,
# in-process -- backend/.env is never written by this.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$backendDir = Split-Path -Parent $PSScriptRoot
Set-Location $backendDir

$env:ARTIFICE_ENABLED = 'true'

$logDir = Join-Path $backendDir '.scout-state'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'artifice-supervisor.log'

while ($true) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] starting artifice" -Encoding utf8
    & npx tsx src/artifice/run.ts 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] artifice exited (code $LASTEXITCODE), restarting in 10s" -Encoding utf8
    Start-Sleep -Seconds 10
}
