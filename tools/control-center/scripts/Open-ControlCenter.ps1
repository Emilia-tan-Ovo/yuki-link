param([Parameter(Mandatory)][string]$Config, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskConfig = Get-Content -LiteralPath $Config -Encoding utf8 | ConvertFrom-Json
$taskConfigId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Config).ToLowerInvariant()))).ToLowerInvariant()
$taskUrl = 'http://127.0.0.1:' + $taskConfig.port
function Test-ControlCenter {
    try {
        $taskPage = Invoke-WebRequest -Uri $taskUrl -TimeoutSec 2 -SessionVariable taskWebSession
        $taskState = Invoke-RestMethod -Uri ($taskUrl + '/api/status') -WebSession $taskWebSession -TimeoutSec 2
        return $taskPage.Content.Contains('Yuki Link · Control Center') -and $taskState.supervisor.name -eq 'yuki-control-center' -and $taskState.supervisor.configId -eq $taskConfigId
    } catch { return $false }
}
if (-not (Test-ControlCenter)) {
    $taskStart = [Diagnostics.ProcessStartInfo]::new($taskConfig.pwsh)
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    foreach ($taskArg in @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',(Join-Path $PSScriptRoot 'Run-Supervisor.ps1'),'-Config',[IO.Path]::GetFullPath($Config))) { $taskStart.ArgumentList.Add($taskArg) }
    $taskProcess = [Diagnostics.Process]::Start($taskStart)
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-ControlCenter)) {
        if ([DateTime]::UtcNow -gt $taskDeadline) { throw 'Control Center did not become ready; inspect port/configuration. No occupying process was stopped.' }
        Start-Sleep -Milliseconds 300
    }
}
if (-not $NoBrowser) { Start-Process $taskUrl }
Write-Output $taskUrl
