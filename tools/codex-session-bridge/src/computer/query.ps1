$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    switch -CaseSensitive ($request.query) {
        'version' {
            $result = @{ version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition }
        }
        'location' {
            $result = @{ path = (Get-Location).Path }
        }
        'system' {
            $result = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, LastBootUpTime
        }
        'processes' {
            $result = @(Get-Process | Sort-Object Id | Select-Object -First 200 -Property Id, ProcessName, CPU, WorkingSet64)
        }
        default { throw 'Unsupported read-only query.' }
    }
    $result | ConvertTo-Json -Depth 4 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
