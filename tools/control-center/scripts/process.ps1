$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$taskRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($taskRequest.action -eq 'port-owner') {
    $taskPort = [int]$taskRequest.port
    if ($taskPort -lt 1 -or $taskPort -gt 65535) { throw 'PORT_INVALID' }
    $taskListeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue)
    $taskOwners = @($taskListeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($taskOwners.Count -eq 1) { Write-Output ([string]$taskOwners[0]) } else { Write-Output 'null' }
    exit 0
}
function Test-TaskMarker([string]$CommandLine, [string]$Marker) {
    if (-not $CommandLine -or -not $Marker) { return $false }
    $taskPattern = '(?i)(?<!\S)"?' + [regex]::Escape($Marker) + '"?(?!\S)'
    return [regex]::IsMatch($CommandLine, $taskPattern)
}
if ($taskRequest.action -eq 'terminate-tree') {
    if (-not $taskRequest.pid -or -not $taskRequest.created -or -not $taskRequest.executable -or -not $taskRequest.markers) { throw 'OWNERSHIP_CHANGED' }
    $taskOwner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$taskRequest.pid)
    if (-not $taskOwner -or $taskOwner.CreationDate.ToUniversalTime().ToString('o') -ne [string]$taskRequest.created `
        -or $taskOwner.ExecutablePath -ine [string]$taskRequest.executable) { throw 'OWNERSHIP_CHANGED' }
    foreach ($taskMarker in $taskRequest.markers) {
        if (-not (Test-TaskMarker $taskOwner.CommandLine ([string]$taskMarker))) { throw 'OWNERSHIP_CHANGED' }
    }
    # Process.Kill(true) acts on the opened process handle, so a recycled PID
    # cannot redirect the forced tree termination after the identity check.
    $taskHandle = [Diagnostics.Process]::GetProcessById([int]$taskRequest.pid)
    if ($taskHandle.StartTime.ToUniversalTime().ToString('o') -ne [string]$taskRequest.created) { throw 'OWNERSHIP_CHANGED' }
    $taskHandle.Kill($true)
    $taskHandle.WaitForExit(10000) | Out-Null
    Write-Output 'true'
    exit 0
}
if ($taskRequest.pid) {
    $taskFilter = 'ProcessId=' + [int]$taskRequest.pid
} else {
    $taskName = [IO.Path]::GetFileName([string]$taskRequest.executable)
    if ($taskName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'INVALID_EXECUTABLE_NAME' }
    $taskFilter = "Name='$taskName'"
}
$taskProcesses = @(Get-CimInstance Win32_Process -Filter $taskFilter)
$taskOutput = @()
foreach ($taskProcess in $taskProcesses) {
    if ($taskRequest.pid -and $taskProcess.ProcessId -ne $taskRequest.pid) { continue }
    $taskCreated = $taskProcess.CreationDate.ToUniversalTime().ToString('o')
    $taskMatches = $taskProcess.ExecutablePath -and $taskProcess.CommandLine -and ($taskProcess.ExecutablePath -ieq $taskRequest.executable)
    foreach ($taskMarker in $taskRequest.markers) {
        if (-not (Test-TaskMarker $taskProcess.CommandLine ([string]$taskMarker))) { $taskMatches = $false }
    }
    if ($taskRequest.pid) {
        $taskOutput += @{ pid=[int]$taskProcess.ProcessId; created=$taskCreated; matches=$taskMatches }
    } elseif ($taskMatches) {
        $taskOutput += @{ pid=[int]$taskProcess.ProcessId; created=$taskCreated; matches=$true }
    }
}
ConvertTo-Json -InputObject @($taskOutput) -Compress
