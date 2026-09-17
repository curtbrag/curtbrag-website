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
if (-not (Test-Path $bridge) -or (Get-Item $bridge).Length -lt 1000) { throw 'Bridge download failed or was unexpectedly small.' }

# Refuse to schedule malformed PowerShell.
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($bridge, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) {
    $parseErrors | ForEach-Object { Write-Host ("PARSE ERROR line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) }
    throw "Downloaded bridge has $($parseErrors.Count) PowerShell parse error(s)."
}
Write-Host 'Bridge syntax check: OK'

$sshKey = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
if (-not (Test-Path $sshKey)) { throw "SSH key missing: $sshKey" }

if (Test-Path $configPath) {
    Write-Host 'Existing bridge configuration found; keeping stored dashboard credentials.'
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
} else {
    $pw = Read-Host 'Dashboard password for https://curtbrag.com/cluster/dashboard/' -AsSecureString
    $pwCipher = ConvertFrom-SecureString $pw
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
}

$secure = ConvertTo-SecureString $config.password_cipher
$plain = [System.Net.NetworkCredential]::new('', $secure).Password
$headers = @{ Authorization = "Bearer $plain"; 'Content-Type' = 'application/json' }
$api = if ($config.api_url) { [string]$config.api_url } else { 'https://curtbrag.com/.netlify/functions/cluster-api' }

$summaryUri = "$($api)?action=summary&_=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
try { $null = Invoke-RestMethod -Uri $summaryUri -Headers $headers -Method Get -TimeoutSec 15 }
catch { throw "Dashboard authentication/API check failed: $($_.Exception.Message)" }
Write-Host 'Dashboard API authentication: OK'

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
Write-Host 'Waiting for Windows bridge heartbeat...'

$ok = $false
for ($i=1; $i -le 18; $i++) {
    Start-Sleep -Seconds 3
    try {
        $uri = "$($api)?action=bridge-status&_=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $b = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 10
        Write-Host ("[{0}/18] alive={1} host={2} last={3}" -f $i,$b.alive,$b.hostname,$b.last_seen_at)
        if ($b.alive -eq $true -and $b.hostname -eq $env:COMPUTERNAME) { $ok=$true; break }
    } catch { Write-Host "Heartbeat check failed: $($_.Exception.Message)" }
}

if (-not $ok) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Host "Task result: $($info.LastTaskResult)"
    $log = Join-Path $base 'bridge.log'
    if (Test-Path $log) { Get-Content $log -Tail 50 }
    throw 'Windows bridge did not become healthy.'
}

Write-Host ''
Write-Host 'WINDOWS BRIDGE ONLINE.'
Write-Host 'Open: https://curtbrag.com/cluster/dashboard/'
Write-Host '============================================================'