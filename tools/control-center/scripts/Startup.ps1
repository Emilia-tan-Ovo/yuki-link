param(
    [ValidateSet('Status','Preview','Install','Enable','Disable','Uninstall')][string]$Action = 'Status',
    [Parameter(Mandatory)][string]$Config
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$taskConfigPath = [IO.Path]::GetFullPath($Config)
$taskConfig = Get-Content -LiteralPath $taskConfigPath -Encoding utf8 | ConvertFrom-Json
$taskName = 'YukiLink-ControlCenter-V0'
$taskMarker = 'Yuki Link Control Center V0: ' + $taskConfigPath
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting -and $taskExisting.Description -ne $taskMarker) { throw 'Task name belongs to a different configuration.' }
if ($Action -notin @('Status','Preview') -and -not $taskConfig.allowStartupChanges) { throw 'Startup configuration changes require user approval.' }
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskRunner = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Run-Supervisor.ps1'))
if ($taskRunner.Contains('"') -or $taskConfigPath.Contains('"')) { throw 'Invalid path.' }
$taskArgs = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskRunner + '" -Config "' + $taskConfigPath + '"'
if ($Action -in @('Preview','Install')) {
    $taskDefinition = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute $taskConfig.pwsh -Argument $taskArgs -WorkingDirectory $PSScriptRoot) `
      -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $taskUser) `
      -Principal (New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited) `
      -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable) `
      -Description $taskMarker
    if ($Action -eq 'Preview') {
        @{ state='preview'; user='current-user'; logon=[string]$taskDefinition.Principal.LogonType; runLevel=[string]$taskDefinition.Principal.RunLevel;
          foregroundRunner=$taskDefinition.Actions.Arguments.Contains('Run-Supervisor.ps1'); restartCount=$taskDefinition.Settings.RestartCount;
          restartInterval=$taskDefinition.Settings.RestartInterval; executionLimit=$taskDefinition.Settings.ExecutionTimeLimit;
          batteriesAllowed=(-not $taskDefinition.Settings.DisallowStartIfOnBatteries); stopOnBattery=$taskDefinition.Settings.StopIfGoingOnBatteries;
          networkRequired=$taskDefinition.Settings.RunOnlyIfNetworkAvailable; wake=$taskDefinition.Settings.WakeToRun;
          multipleInstances=[string]$taskDefinition.Settings.MultipleInstances } | ConvertTo-Json
        exit 0
    }
    if ($taskExisting) { throw 'Task already exists; use Enable. Existing configuration was not overwritten.' }
    Register-ScheduledTask -TaskName $taskName -InputObject $taskDefinition | Out-Null
} elseif ($Action -eq 'Enable') {
    Enable-ScheduledTask -TaskName $taskName | Out-Null
} elseif ($Action -eq 'Disable') {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
} elseif ($Action -eq 'Uninstall' -and $taskExisting) {
    # Backup first. Unregister does not stop running services or delete history.
    $taskBackup = Join-Path $taskConfig.stateDir ('startup-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $taskBackup -Encoding utf8
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$taskResult = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
@{ state=if ($taskResult) { [string]$taskResult.State } else { '未安装' }; installed=[bool]$taskResult; enabled=if ($taskResult) {$taskResult.Settings.Enabled} else {$false} } | ConvertTo-Json -Compress
