param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$StateDigest,
    [Parameter(Mandatory = $true)][string]$ReservationFile,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f-]{36}$')][string]$Nonce,
    [Parameter(Mandatory = $true)][int]$OwnerPid,
    [string]$Instance = '',
    [string]$ConfigId = '',
    [ValidateSet('acquire', 'settle')][string]$Mode = 'acquire'
)

# The mutex covers all Windows sessions. The reservation covers the callback
# even if this helper dies before the Node supervisor finishes the callback.
$mutex = [System.Threading.Mutex]::new($false, "Global\YukiLinkControlCenterMutation-$StateDigest")
$held = $false
try {
    try { $held = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { [Console]::Out.WriteLine('BUSY'); return }
    $existing = $null
    if ([System.IO.File]::Exists($ReservationFile)) {
        try { $existing = [System.IO.File]::ReadAllText($ReservationFile) | ConvertFrom-Json -ErrorAction Stop }
        catch { [Console]::Out.WriteLine('UNAVAILABLE'); return }
        if (-not $existing.pid -or [string]$existing.created -notmatch '^\d+$' -or
            [string]$existing.nonce -notmatch '^[0-9a-f-]{36}$') {
            [Console]::Out.WriteLine('UNAVAILABLE'); return
        }
    }
    if ($Mode -eq 'settle') {
        if ($existing -and $existing.nonce -eq $Nonce -and [int]$existing.pid -eq $OwnerPid) {
            [System.IO.File]::Delete($ReservationFile)
        }
        [Console]::Out.WriteLine('SETTLED')
        return
    }
    if ($existing) {
        try { $owner = [System.Diagnostics.Process]::GetProcessById([int]$existing.pid) }
        catch [System.ArgumentException] { $owner = $null }
        if ($owner) {
            try { $created = $owner.StartTime.ToUniversalTime().Ticks.ToString() }
            catch { [Console]::Out.WriteLine('UNAVAILABLE'); return }
            if ($created -eq [string]$existing.created) { [Console]::Out.WriteLine('BUSY'); return }
        }
    }
    $owner = Get-Process -Id $OwnerPid -ErrorAction Stop
    $record = @{ pid = $OwnerPid; created = $owner.StartTime.ToUniversalTime().Ticks.ToString(); nonce = $Nonce;
        instance = $Instance; configId = $ConfigId } | ConvertTo-Json -Compress
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($ReservationFile)) | Out-Null
    $temporary = "$ReservationFile.$Nonce.tmp"
    [System.IO.File]::WriteAllText($temporary, $record, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($temporary, $ReservationFile, $true)
    [Console]::Out.WriteLine('ACQUIRED')
    [Console]::Out.Flush()
    $instruction = [Console]::In.ReadLine()
    if ($instruction -eq 'RELEASE' -and [System.IO.File]::Exists($ReservationFile)) {
        $current = [System.IO.File]::ReadAllText($ReservationFile) | ConvertFrom-Json
        if ($current.nonce -eq $Nonce -and [int]$current.pid -eq $OwnerPid) { [System.IO.File]::Delete($ReservationFile) }
    }
} catch {
    [Console]::Out.WriteLine('UNAVAILABLE')
} finally {
    [Console]::Out.Flush()
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
