# Keeps Scout running continuously -- relaunches it immediately if it ever exits, for any reason
# (crash, an unreachable Ollama host, etc.). Registered as a Windows Scheduled Task (trigger:
# ONLOGON for the current user -- see the operator's own setup, "TeraTradeScout" task) so Scout
# comes back on its own after a reboot or logoff, independent of any particular terminal or
# Claude Code session staying open.
#
# Sets SCOUT_ENABLED itself, in-process -- backend/.env is never written by this (or anything
# else automated): see CLAUDE.md's "never commit or modify .env" rule.

$ErrorActionPreference = 'Stop'
# [Console]::OutputEncoding alone does NOT fix this -- confirmed live (still wrote UTF-16LE to the
# log even with it set). *>> redirects the child's raw bytes directly; it's the PIPELINE capture
# below (2>&1 | Out-File) that actually decodes through OutputEncoding and re-writes as real UTF-8.
#
# 2026-09-08: wrapped in try/catch -- confirmed live this throws ("The handle is invalid") when
# launched by Task Scheduler with no attached console (unlike an interactive/Start-Process launch,
# which always has a real, even if hidden, console handle). With $ErrorActionPreference='Stop' above
# and no try/catch, that exception killed the whole script before the while loop below ever ran even
# once -- confirmed by the log file having zero entries from any Task-Scheduler-triggered run, not
# even the loop's own first "starting scout" line. $OutputEncoding (the PowerShell-level variable,
# separate from [Console]::OutputEncoding) doesn't touch a console handle and was never the problem,
# but wrapped too for the same defensive reason.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$backendDir = Split-Path -Parent $PSScriptRoot
Set-Location $backendDir

$env:SCOUT_ENABLED = 'true'

$logDir = Join-Path $backendDir '.scout-state'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'scout-supervisor.log'

# Unbounded restart loop by design -- this IS the "always running no matter what" behavior. A
# crash-looping Scout (e.g. Ollama host down) just retries every 10s rather than giving up; the
# 10s delay keeps a genuine crash loop from spinning hot.
while ($true) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] starting scout" -Encoding utf8
    & npx tsx src/scout/run.ts 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "[$timestamp] scout exited (code $LASTEXITCODE), restarting in 10s" -Encoding utf8
    Start-Sleep -Seconds 10
}
