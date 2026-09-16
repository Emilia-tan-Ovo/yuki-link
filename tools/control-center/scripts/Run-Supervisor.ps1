param([Parameter(Mandatory)][string]$Config)
$ErrorActionPreference = 'Stop'
$Config = [IO.Path]::GetFullPath($Config)
$taskConfig = Get-Content -LiteralPath $Config -Encoding utf8 | ConvertFrom-Json
$taskEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/main.js'))
Set-Location -LiteralPath ([IO.Path]::GetDirectoryName($taskEntry))
# A manually opened manager may already be running when the login task starts.
# Track that verified Node lifetime instead of exiting immediately and losing
# scheduled failure supervision. An occupied unrelated port is never adopted.
$taskConfigId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Config).ToLowerInvariant()))).ToLowerInvariant()
try {
    $taskUrl = 'http://127.0.0.1:' + $taskConfig.port
    $null = Invoke-WebRequest -Uri $taskUrl -TimeoutSec 2 -SessionVariable taskWebSession
    $taskStatus = Invoke-RestMethod -Uri ($taskUrl + '/api/status') -WebSession $taskWebSession -TimeoutSec 2
    if ($taskStatus.supervisor.name -eq 'yuki-control-center' -and $taskStatus.supervisor.configId -eq $taskConfigId) {
        $taskOwner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$taskStatus.supervisor.pid)
        if ($taskOwner.ExecutablePath -ieq $taskConfig.node -and $taskOwner.CommandLine.Contains($taskEntry) -and $taskOwner.CommandLine.Contains([IO.Path]::GetFullPath($Config))) {
            Wait-Process -Id $taskOwner.ProcessId -ErrorAction SilentlyContinue
            # Let Task Scheduler apply its finite retry budget after an exit.
            exit 1
        }
    }
} catch { }
# Stay in foreground and propagate the child exit code so Task Scheduler tracks
# the real lifetime and can apply bounded failure retries.
& $taskConfig.node $taskEntry '--config' ([IO.Path]::GetFullPath($Config))
exit $LASTEXITCODE
