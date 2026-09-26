param([Parameter(Mandatory)][string]$Target, [ValidateSet('restrict','verify')][string]$Action = 'verify')
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Target -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private directory unavailable' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($Action -eq 'restrict') {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Target -AclObject $acl
}
$actual = Get-Acl -LiteralPath $Target
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or $rules[0].InheritanceFlags -ne 'ContainerInherit,ObjectInherit') { throw 'Private directory verification failed' }
