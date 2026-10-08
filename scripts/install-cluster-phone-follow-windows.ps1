param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$AdbPath
)
$ErrorActionPreference = 'Stop'
$base = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CurtCluster'))
$destination = [System.IO.Path]::GetFullPath((Join-Path $base 'PhoneFollow'))
if (-not $destination.StartsWith($base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Invalid phone follower installation directory.'
}
foreach ($dependency in @($NodePath, $AdbPath, (Join-Path $base 'bridge-config.json'))) {
    if (-not (Test-Path -LiteralPath $dependency -PathType Leaf)) { throw 'An existing phone follower prerequisite is missing.' }
}
$taskName = 'CurtClusterPhoneFollow'
$launcher = Join-Path $destination 'curt-cluster-phone-follow-windows.ps1'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Arguments -notlike ('*"' + $launcher + '"*'))) {
    throw 'A different task already uses the phone follower name.'
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in @('curt-cluster-phone-follow-windows.ps1', 'cluster-phone-follow.cjs')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $destination $name) -Force
}
if (-not $existing) {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '" -NodePath "' + $NodePath + '" -AdbPath "' + $AdbPath + '"'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $destination
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Checks opt-in S26 URL-follow state. Reads the browser and dispatches links only during an explicitly started, unexpired session.' | Out-Null
    $existing = Get-ScheduledTask -TaskName $taskName
}
if ($existing.Settings.Enabled) { Start-ScheduledTask -TaskName $taskName }
[pscustomobject]@{ task=$taskName; enabled=[bool]$existing.Settings.Enabled; installed=$true; watching_requires_explicit_start=$true } | ConvertTo-Json -Compress
