param([Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$StateDigest)

$mutex = [System.Threading.Mutex]::new($false, "Local\YukiLinkControlCenterMutation-$StateDigest")
$held = $false
try {
    try { $held = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) {
        [Console]::Out.WriteLine('BUSY')
        [Console]::Out.Flush()
        return
    }
    [Console]::Out.WriteLine('ACQUIRED')
    [Console]::Out.Flush()
    [void][Console]::In.ReadLine()
}
finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
