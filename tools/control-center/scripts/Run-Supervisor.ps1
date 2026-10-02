param([Parameter(Mandatory)][string]$Config)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Config = [IO.Path]::GetFullPath($Config)
$taskConfig = Get-Content -LiteralPath $Config -Encoding utf8 | ConvertFrom-Json
$taskStateDir = [IO.Path]::GetFullPath([string]$taskConfig.stateDir)
$taskFallback = Join-Path $taskStateDir 'launcher/last-good.json'
$taskConfigId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Config.ToLowerInvariant()))).ToLowerInvariant()

function Resolve-Entry {
    if ($taskConfig.yca.deploymentRoot) {
        try {
            $taskRoot = [IO.Path]::GetFullPath([string]$taskConfig.yca.deploymentRoot)
            $taskSelected = Get-Content -LiteralPath (Join-Path $taskRoot 'selected.json') -Encoding utf8 | ConvertFrom-Json
            if ($taskSelected.commit -notmatch '^[a-f0-9]{40}$') { throw 'DEPLOYMENT_INVALID' }
            $taskEntry = Join-Path $taskRoot ('releases/' + $taskSelected.commit + '/tools/control-center/src/main.js')
            if (-not (Test-Path -LiteralPath $taskEntry -PathType Leaf)) { throw 'CONTROL_CENTER_ENTRY_MISSING' }
            return @{ entry=[IO.Path]::GetFullPath($taskEntry); commit=$taskSelected.commit }
        } catch {
            if (Test-Path -LiteralPath $taskFallback) {
                $taskGood = Get-Content -LiteralPath $taskFallback -Encoding utf8 | ConvertFrom-Json
                if ($taskGood.config -eq $Config -and (Test-Path -LiteralPath $taskGood.entry -PathType Leaf)) {
                    return @{ entry=[IO.Path]::GetFullPath($taskGood.entry); commit='last-good' }
                }
            }
            throw
        }
    }
    $taskInstalled = Join-Path $PSScriptRoot 'launcher.json'
    $taskMetadata = Get-Content -LiteralPath $taskInstalled -Encoding utf8 | ConvertFrom-Json
    if ($taskMetadata.config -ne $Config -or -not (Test-Path -LiteralPath $taskMetadata.entry -PathType Leaf)) { throw 'CONTROL_CENTER_ENTRY_MISSING' }
    return @{ entry=[IO.Path]::GetFullPath($taskMetadata.entry); commit=$null }
}

function Test-RunningManager([string]$Entry) {
    try {
        $taskUrl = 'http://127.0.0.1:' + $taskConfig.port
        $null = Invoke-WebRequest -Uri $taskUrl -TimeoutSec 2 -SessionVariable taskWebSession
        $taskStatus = Invoke-RestMethod -Uri ($taskUrl + '/api/status') -WebSession $taskWebSession -TimeoutSec 2
        if ($taskStatus.supervisor.name -ne 'yuki-control-center' -or $taskStatus.supervisor.configId -ne $taskConfigId) { return $false }
        $taskOwner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$taskStatus.supervisor.pid)
        if (-not $taskOwner -or $taskOwner.ExecutablePath -ine $taskConfig.node -or -not $taskOwner.CommandLine.Contains($Config)) { return $null }
        $taskHandle = [Diagnostics.Process]::GetProcessById([int]$taskOwner.ProcessId)
        $taskHandle.WaitForExit()
        return $taskHandle.ExitCode
    } catch { return $null }
}

$taskFailures = 0
$taskLastSelected = $null
while ($true) {
    try {
        $taskResolved = Resolve-Entry
        if ($taskResolved.commit -ne $taskLastSelected) { $taskFailures = 0; $taskLastSelected = $taskResolved.commit }
        $taskEntry = $taskResolved.entry
        if ($taskFailures -ge 3 -and (Test-Path -LiteralPath $taskFallback)) {
            $taskGood = Get-Content -LiteralPath $taskFallback -Encoding utf8 | ConvertFrom-Json
            if ($taskGood.config -eq $Config -and (Test-Path -LiteralPath $taskGood.entry -PathType Leaf)) { $taskEntry = $taskGood.entry }
        }
        $taskExistingExit = Test-RunningManager $taskEntry
        if ($null -ne $taskExistingExit) {
            if ($taskExistingExit -eq 0) { exit 0 }
            $taskFailures++
        } else {
            Set-Location -LiteralPath ([IO.Path]::GetDirectoryName($taskEntry))
            & $taskConfig.node $taskEntry '--config' $Config
            if ($LASTEXITCODE -eq 0) { exit 0 } # explicit graceful manager stop
            $taskFailures++
        }
    } catch { $taskFailures++ }
    $taskDelay = [Math]::Min(300, [Math]::Pow(2, [Math]::Min($taskFailures, 8)))
    Start-Sleep -Seconds $taskDelay
}
