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

function Install-ClusterBridgeCode {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Directory)
    $helperSource = [uri]::new([uri]$Source, 'cluster-site-session.ps1').AbsoluteUri
    $files = @(
        @{Name='cluster-site-session.ps1'; Uri=$helperSource; Minimum=500},
        @{Name='curt-cluster-bridge-windows.ps1'; Uri=$Source; Minimum=1000}
    )
    try {
        # Validate both downloads before replacing either installed file. A
        # failed download must not leave a running bridge without its helper.
        foreach ($file in $files) {
            $file.Stage = Join-Path $Directory ('.bridge-download-' + [Guid]::NewGuid().ToString('N') + '.ps1')
            Invoke-WebRequest -Uri $file.Uri -OutFile $file.Stage -UseBasicParsing -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $file.Stage) -or (Get-Item -LiteralPath $file.Stage).Length -lt $file.Minimum) {
                throw "Download failed or was unexpectedly small: $($file.Name)"
            }
            $tokens = $null
            $parseErrors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($file.Stage, [ref]$tokens, [ref]$parseErrors)
            if ($parseErrors.Count) { throw "Downloaded $($file.Name) has $($parseErrors.Count) PowerShell parse error(s)." }
        }
        foreach ($file in $files) {
            Move-Item -LiteralPath $file.Stage -Destination (Join-Path $Directory $file.Name) -Force
        }
    } finally {
        foreach ($file in $files) {
            if ($file.Stage -and (Test-Path -LiteralPath $file.Stage)) { Remove-Item -LiteralPath $file.Stage -Force }
        }
    }
}

Write-Host 'Downloading current bridge and site session helper...'
Install-ClusterBridgeCode -Source $RepoRaw -Directory $base
. (Join-Path $base 'cluster-site-session.ps1')
Write-Host 'Bridge and session helper syntax checks: OK'

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
try { $null = Invoke-CurtClusterRequest -Request @{Uri=$summaryUri;Headers=$headers;Method='Get';TimeoutSec=15} -Password $plain }
catch { throw "Dashboard authentication/API check failed: $($_.Exception.Message)" }
Write-Host 'Dashboard API authentication: OK'

# Retire the duplicate queue consumer so it cannot take newer bridge commands.
$legacyPattern = 'curt-cluster-command-worker-windows\.ps1'
Get-ScheduledTask | Where-Object { ($_.Actions.Arguments -join ' ') -match $legacyPattern } |
    ForEach-Object {
        Stop-ScheduledTask -InputObject $_ -ErrorAction SilentlyContinue
        Disable-ScheduledTask -InputObject $_ | Out-Null
    }
Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -match $legacyPattern
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -like '*curt-cluster-bridge-windows.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }

$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bridge`" -ConfigPath `"$configPath`" -NoMining"
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
        $b = Invoke-CurtClusterRequest -Request @{Uri=$uri;Headers=$headers;Method='Get';TimeoutSec=10} -Password $plain
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
