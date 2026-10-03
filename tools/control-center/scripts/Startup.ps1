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
$taskLauncherDir = Join-Path $taskConfig.stateDir 'launcher'
$taskRunner = [IO.Path]::GetFullPath((Join-Path $taskLauncherDir 'Run-Supervisor.ps1'))
if ($taskRunner.Contains('"') -or $taskConfigPath.Contains('"')) { throw 'Invalid path.' }
$taskArgs = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskRunner + '" -Config "' + $taskConfigPath + '"'
if ($Action -in @('Preview','Install','Enable')) {
    $taskTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User $taskUser),
      (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)))
    $taskDefinition = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute $taskConfig.pwsh -Argument $taskArgs -WorkingDirectory $PSScriptRoot) `
      -Trigger $taskTriggers `
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
    if ($Action -eq 'Install' -and $taskExisting) { throw 'Task already exists; use Enable. Existing configuration was not overwritten.' }
    if ($Action -eq 'Enable' -and -not $taskExisting) { throw 'Task is not installed.' }
    New-Item -ItemType Directory -Path $taskLauncherDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Run-Supervisor.ps1') -Destination $taskRunner -Force
    @{ config=$taskConfigPath; entry=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/main.js')) } |
      ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $taskLauncherDir 'launcher.json') -Encoding utf8
    Register-ScheduledTask -TaskName $taskName -InputObject $taskDefinition -Force | Out-Null
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
