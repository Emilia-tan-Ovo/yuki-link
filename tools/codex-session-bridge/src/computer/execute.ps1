$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
try {
    if ($PSVersionTable.PSVersion -lt [version]'7.4') {
        throw 'Script execution requires PowerShell 7.4 or later for native error handling.'
    }
    $PSNativeCommandUseErrorActionPreference = $true
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    & ([scriptblock]::Create($request.script))
    exit 0
} catch {
    [Console]::Error.WriteLine(('{0}: {1}' -f $_.FullyQualifiedErrorId, $_.Exception.Message))
    if ($_.InvocationInfo.PositionMessage) {
        [Console]::Error.WriteLine($_.InvocationInfo.PositionMessage)
    }
    if ($_.Exception -is [System.Management.Automation.NativeCommandExitException]) {
        exit $_.Exception.ExitCode
    }
    exit 1
}
