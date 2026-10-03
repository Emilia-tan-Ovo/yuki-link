$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$taskRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json -DateKind String
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
function Test-TaskHandleBirth([Diagnostics.Process]$Process, [string]$Created) {
    try {
        $taskExpected = [DateTimeOffset]::Parse($Created, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime.Ticks
        # CIM records microseconds; the opened process handle can retain a
        # sub-microsecond tick. This still excludes a recycled PID.
        return [Math]::Abs($Process.StartTime.ToUniversalTime().Ticks - $taskExpected) -lt 10
    } catch { return $false }
}
if ($taskRequest.action -in @('inspect-venv-child', 'terminate-venv-tree')) {
    $taskTerminate = $taskRequest.action -eq 'terminate-venv-tree'
    if (-not $taskRequest.rootPid -or -not $taskRequest.rootCreated -or -not $taskRequest.childPid `
        -or -not $taskRequest.executable -or -not $taskRequest.markers -or -not $taskRequest.port) { throw 'OWNERSHIP_CHANGED' }
    if ($taskTerminate -and -not $taskRequest.childCreated) { throw 'OWNERSHIP_CHANGED' }
    $taskRoot = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$taskRequest.rootPid)
    $taskChild = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$taskRequest.childPid)
    $taskValid = $taskRoot -and $taskChild -and
        $taskRoot.CreationDate.ToUniversalTime().ToString('o') -eq [string]$taskRequest.rootCreated -and
        $taskRoot.ExecutablePath -ieq [string]$taskRequest.executable -and
        [int]$taskChild.ParentProcessId -eq [int]$taskRoot.ProcessId -and
        $taskChild.CreationDate.ToUniversalTime().Ticks -gt $taskRoot.CreationDate.ToUniversalTime().Ticks
    if ($taskTerminate -and $taskChild -and
        $taskChild.CreationDate.ToUniversalTime().ToString('o') -ne [string]$taskRequest.childCreated) { $taskValid = $false }
    if ($taskValid) {
        foreach ($taskMarker in $taskRequest.markers) {
            if (-not (Test-TaskMarker $taskRoot.CommandLine ([string]$taskMarker)) `
                -or -not (Test-TaskMarker $taskChild.CommandLine ([string]$taskMarker))) { $taskValid = $false; break }
        }
    }
    $taskVenvExe = [string]$taskRequest.executable
    $taskScripts = [IO.Path]::GetDirectoryName($taskVenvExe)
    if ([IO.Path]::GetFileName($taskVenvExe) -ine 'python.exe' -or [IO.Path]::GetFileName($taskScripts) -ine 'Scripts') { $taskValid = $false }
    $taskCfg = Join-Path ([IO.Path]::GetDirectoryName($taskScripts)) 'pyvenv.cfg'
    if (-not [IO.File]::Exists($taskCfg)) { $taskValid = $false }
    if ($taskValid) {
        $taskHomes = @([IO.File]::ReadAllLines($taskCfg) | Where-Object { $_ -match '^\s*home\s*=' })
        if ($taskHomes.Count -ne 1 -or $taskHomes[0] -notmatch '^\s*home\s*=\s*(.+?)\s*$') { $taskValid = $false }
        else {
            $taskHome = $Matches[1].Trim('"')
            if (-not [IO.Path]::IsPathFullyQualified($taskHome)) { $taskValid = $false }
            else {
                $taskBaseExe = [IO.Path]::GetFullPath((Join-Path $taskHome 'python.exe'))
                if (-not [IO.File]::Exists($taskBaseExe) -or $taskChild.ExecutablePath -ine $taskBaseExe) { $taskValid = $false }
            }
        }
    }
    if ($taskValid) {
        # uv versions may place either the venv redirector or its configured
        # base interpreter at argv[0]. Both must trace to this pyvenv.cfg.
        $taskVenvPrefix = '^\s*"?' + [regex]::Escape($taskVenvExe) + '"?(?=\s|$)'
        $taskBasePrefix = '^\s*"?' + [regex]::Escape($taskBaseExe) + '"?(?=\s|$)'
        if (-not ([regex]::IsMatch($taskChild.CommandLine, $taskVenvPrefix, [Text.RegularExpressions.RegexOptions]::IgnoreCase) `
            -or [regex]::IsMatch($taskChild.CommandLine, $taskBasePrefix, [Text.RegularExpressions.RegexOptions]::IgnoreCase))) { $taskValid = $false }
        $taskListeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ([int]$taskRequest.port) -State Listen -ErrorAction SilentlyContinue)
        $taskOwners = @($taskListeners | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($taskOwners.Count -ne 1 -or [int]$taskOwners[0] -ne [int]$taskChild.ProcessId) { $taskValid = $false }
    }
    if ($taskValid) {
        try {
            $taskRootHandle = [Diagnostics.Process]::GetProcessById([int]$taskRoot.ProcessId)
            $taskChildHandle = [Diagnostics.Process]::GetProcessById([int]$taskChild.ProcessId)
            if (-not (Test-TaskHandleBirth $taskRootHandle $taskRoot.CreationDate.ToUniversalTime().ToString('o')) `
                -or -not (Test-TaskHandleBirth $taskChildHandle $taskChild.CreationDate.ToUniversalTime().ToString('o'))) { $taskValid = $false }
        } catch { $taskValid = $false }
    }
    if ($taskValid -and $taskTerminate) {
        try {
            $taskRootHandle.Kill($true)
            if ($taskRootHandle.WaitForExit(10000)) { Write-Output 'true' }
            else { Write-Output 'unknown' }
        } catch { Write-Output 'unknown' }
    } elseif ($taskValid) {
        ConvertTo-Json -InputObject @{ pid=[int]$taskChild.ProcessId; created=$taskChild.CreationDate.ToUniversalTime().ToString('o'); matches=$true } -Compress
    } elseif ($taskTerminate) { Write-Output 'false' }
    else { Write-Output 'null' }
    exit 0
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
    if (-not (Test-TaskHandleBirth $taskHandle ([string]$taskRequest.created))) { throw 'OWNERSHIP_CHANGED' }
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
