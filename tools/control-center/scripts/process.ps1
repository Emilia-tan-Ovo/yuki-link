$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$taskRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
$taskFilter = if ($taskRequest.pid) { 'ProcessId=' + [int]$taskRequest.pid } else { "Name='node.exe' OR Name='tunnel-client.exe'" }
$taskProcesses = @(Get-CimInstance Win32_Process -Filter $taskFilter)
$taskOutput = @()
foreach ($taskProcess in $taskProcesses) {
    if ($taskRequest.pid -and $taskProcess.ProcessId -ne $taskRequest.pid) { continue }
    $taskCreated = $taskProcess.CreationDate.ToUniversalTime().ToString('o')
    $taskMatches = $taskProcess.ExecutablePath -and $taskProcess.CommandLine -and ($taskProcess.ExecutablePath -ieq $taskRequest.executable)
    foreach ($taskMarker in $taskRequest.markers) {
        if (-not $taskProcess.CommandLine -or -not $taskProcess.CommandLine.Contains([string]$taskMarker, [StringComparison]::OrdinalIgnoreCase)) { $taskMatches = $false }
    }
    if ($taskRequest.pid) {
        $taskOutput += @{ pid=[int]$taskProcess.ProcessId; created=$taskCreated; matches=$taskMatches }
    } elseif ($taskMatches) {
        $taskOutput += @{ pid=[int]$taskProcess.ProcessId; created=$taskCreated; matches=$true }
    }
}
ConvertTo-Json -InputObject @($taskOutput) -Compress
