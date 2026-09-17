param(
    [string]$RepoRaw = 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/curt-cluster-bridge-windows.ps1'
)

$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'CurtCluster'
$bridge = Join-Path $base 'curt-cluster-bridge-windows.ps1'
$configPath = Join-Path $base 'bridge-config.json'
$taskName = 'CurtClusterBridge'

New-Item -ItemType Directory -Force -Path $base | Out-Null

Write-Host ''
Write-Host '============================================================'
Write-Host ' CURT CLUSTER - WINDOWS LIVE BRIDGE INSTALLER'
Write-Host '============================================================'
Write-Host ''

Write-Host 'Downloading current bridge...'
Invoke-WebRequest -Uri $RepoRaw -OutFile $bridge -UseBasicParsing

if (-not (Test-Path $bridge) -or (Get-Item $bridge).Length -lt 1000) {
    throw 'Bridge download failed or was unexpectedly small.'
}

$sshKey = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
if (-not (Test-Path $sshKey)) { throw "SSH key missing: $sshKey" }

$pw = Read-Host 'Dashboard password for https://curtbrag.com/cluster/dashboard/' -AsSecureString
$pwCipher = ConvertFrom-SecureString $pw

# Public wallet already used by the existing cluster configuration. This is not a secret.
$wallet = '44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT'

$config = [ordered]@{
    api_url = 'https://curtbrag.com/.netlify/functions/cluster-api'
    password_cipher = $pwCipher
    wallet = $wallet
    pool_host = 'gulf.moneroocean.stream'
    pool_port = 10128
    ssh_key = $sshKey
    phone_user = 'user'
    phone_port = 8022
}
$config | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8

# Validate dashboard credentials before installing persistence.
$plain = [System.Net.NetworkCredential]::new('', $pw).Password
$headers = @{ Authorization = "Bearer $plain"; 'Content-Type' = 'application/json' }
try {
    $probe = Invoke-RestMethod -Uri 'https://curtbrag.com/.netlify/functions/cluster-api?action=summary' -Headers $headers -Method Get -TimeoutSec 15
} catch {
    throw "Dashboard authentication/API check failed: $($_.Exception.Message)"
}

Write-Host 'Dashboard API authentication: OK'

# Stop/remove prior copy if present.
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*curt-cluster-bridge-windows.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }

$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bridge`" -ConfigPath `"$configPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Keeps curtbrag.com cluster dashboard synchronized with the live phone fleet.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host ''
Write-Host 'Bridge task installed and started.'
Write-Host "Config: $configPath"
Write-Host "Log:    $base\bridge.log"
Write-Host ''
Write-Host 'Waiting briefly for first dashboard heartbeat...'
Start-Sleep -Seconds 8

try {
    $b = Invoke-RestMethod -Uri 'https://curtbrag.com/.netlify/functions/cluster-api?action=bridge-status' -Headers $headers -Method Get -TimeoutSec 15
    Write-Host ("Bridge alive: {0}" -f $b.alive)
    Write-Host ("Bridge host:  {0}" -f $b.hostname)
    Write-Host ("Last seen:    {0}" -f $b.last_seen_at)
} catch {
    Write-Warning "Could not verify heartbeat yet: $($_.Exception.Message)"
}

Write-Host ''
Write-Host 'Open: https://curtbrag.com/cluster/dashboard/'
Write-Host '============================================================'
