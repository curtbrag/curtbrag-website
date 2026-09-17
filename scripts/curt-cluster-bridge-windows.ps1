param(
    [string]$ConfigPath = "$env:LOCALAPPDATA\CurtCluster\bridge-config.json"
)

$ErrorActionPreference = 'Stop'

$base = Join-Path $env:LOCALAPPDATA 'CurtCluster'
$logPath = Join-Path $base 'bridge.log'
New-Item -ItemType Directory -Force -Path $base | Out-Null

function Write-Log([string]$Message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$stamp] $Message"
    Write-Host $line
    try { Add-Content -Path $logPath -Value $line -ErrorAction SilentlyContinue } catch {}
}

if (-not (Test-Path $ConfigPath)) {
    Write-Log "Missing config: $ConfigPath"
    exit 2
}

try {
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $secure = ConvertTo-SecureString $config.password_cipher
    $password = [System.Net.NetworkCredential]::new('', $secure).Password
}
catch {
    Write-Log "Cannot load/decrypt bridge config: $($_.Exception.Message)"
    exit 2
}

$api = if ($config.api_url) { [string]$config.api_url } else { 'https://curtbrag.com/.netlify/functions/cluster-api' }
$wallet = [string]$config.wallet
$poolHost = if ($config.pool_host) { [string]$config.pool_host } else { 'gulf.moneroocean.stream' }
$poolPort = if ($config.pool_port) { [int]$config.pool_port } else { 10128 }
$phonePort = if ($config.phone_port) { [int]$config.phone_port } else { 8022 }
$phoneUser = if ($config.phone_user) { [string]$config.phone_user } else { 'user' }
$key = if ($config.ssh_key) { [string]$config.ssh_key } else { "$env:USERPROFILE\.ssh\id_ed25519" }
$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
$bridgeStartMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

if (-not $ssh -or -not (Test-Path $key)) {
    Write-Log "SSH client/key missing. ssh=$ssh key=$key"
    exit 2
}
if ($poolHost -notmatch '^[A-Za-z0-9._-]+$') {
    Write-Log "Invalid pool host in config: $poolHost"
    exit 2
}
if ($wallet -notmatch '^[A-Za-z0-9]+$') {
    Write-Log 'Invalid wallet value in bridge config.'
    exit 2
}

$phones = @(
    [pscustomobject]@{ Hostname='phone173'; IP='192.168.1.173' },
    [pscustomobject]@{ Hostname='phone174'; IP='192.168.1.174' },
    [pscustomobject]@{ Hostname='phone195'; IP='192.168.1.195' },
    [pscustomobject]@{ Hostname='phone176'; IP='192.168.1.176' },
    [pscustomobject]@{ Hostname='phone177'; IP='192.168.1.177' },
    [pscustomobject]@{ Hostname='phone191'; IP='192.168.1.191' },
    [pscustomobject]@{ Hostname='phone253'; IP='192.168.1.253' },
    [pscustomobject]@{ Hostname='phone254'; IP='192.168.1.254' }
)

$headers = @{ Authorization = "Bearer $password"; 'Content-Type' = 'application/json' }

function Get-ApiUri([string]$Action) {
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    return "$($api)?action=$([uri]::EscapeDataString($Action))&_=$stamp"
}

function Invoke-ApiGet([string]$Action) {
    try {
        return Invoke-RestMethod -Uri (Get-ApiUri $Action) -Headers $headers -Method Get -TimeoutSec 20
    }
    catch {
        Write-Log "API GET $Action failed: $($_.Exception.Message)"
        return $null
    }
}

function Invoke-ApiPost([string]$Action, $Body) {
    try {
        $json = $Body | ConvertTo-Json -Depth 12 -Compress
        return Invoke-RestMethod -Uri (Get-ApiUri $Action) -Headers $headers -Method Post -Body $json -TimeoutSec 20
    }
    catch {
        Write-Log "API POST $Action failed: $($_.Exception.Message)"
        return $null
    }
}

function Invoke-Phone([string]$IP, [string]$Remote) {
    $args = @(
        '-n', '-p', "$phonePort",
        '-i', $key,
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ConnectTimeout=5',
        '-o', 'ConnectionAttempts=1',
        '-o', 'ServerAliveInterval=2',
        '-o', 'ServerAliveCountMax=2',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=NUL',
        '-o', 'LogLevel=ERROR',
        "$phoneUser@$IP",
        $Remote
    )
    try {
        $out = @(& $ssh @args 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        return [pscustomobject]@{ Exit = $code; Output = $out }
    }
    catch {
        return [pscustomobject]@{ Exit = 1; Output = @($_.Exception.Message) }
    }
}

function Get-Devices {
    $r = Invoke-ApiGet 'devices'
    if ($r -and $r.devices) { return @($r.devices) }
    return @()
}

function Ensure-Device([string]$Hostname, [string]$IP, [string]$Class='phone', [string]$Role='worker') {
    $devices = @(Get-Devices)
    $d = $devices | Where-Object hostname -eq $Hostname | Select-Object -First 1
    if ($d -and $d.current_ip -and $d.current_ip -ne $IP) {
        Invoke-ApiPost 'delete-device' @{ device_id = $d.id } | Out-Null
        $d = $null
    }
    if (-not $d) {
        Invoke-ApiPost 'create-device' @{
            hostname = $Hostname
            ip = $IP
            device_class = $Class
            cluster_role = $Role
        } | Out-Null
    }
}

function Reconcile-Registry {
    Write-Log 'Reconciling dashboard registry to current hardware.'

    $devices = @(Get-Devices)
    foreach ($stale in @($devices | Where-Object hostname -eq 'phone175')) {
        Invoke-ApiPost 'delete-device' @{ device_id = $stale.id } | Out-Null
    }

    foreach ($p in $phones) {
        Ensure-Device $p.Hostname $p.IP 'phone' 'worker'
    }
    Ensure-Device 'nexus' '192.168.1.192' 'pc' 'control-plane'

    $devices = @(Get-Devices)
    foreach ($p in $phones) {
        $d = $devices | Where-Object hostname -eq $p.Hostname | Select-Object -First 1
        if ($d -and ((-not $d.desired.pool_url) -or $d.desired.pool_url -eq '192.168.1.179')) {
            Invoke-ApiPost 'set-pool-config' @{
                device_id = $d.id
                pool_url = $poolHost
                pool_port = $poolPort
                thread_count = 6
                randomx_mode = 'light'
            } | Out-Null
        }
    }

    $devices = @(Get-Devices)
    $phoneIds = @($devices | Where-Object { $_.hostname -in $phones.Hostname } | ForEach-Object { $_.id })
    $nexusIds = @($devices | Where-Object hostname -eq 'nexus' | ForEach-Object { $_.id })

    Invoke-ApiPost 'save-group' @{
        group_id='phones'; group_name='Phones';
        description='Current eight OnePlus 6T workers'; device_ids=$phoneIds
    } | Out-Null
    Invoke-ApiPost 'save-group' @{
        group_id='pcs'; group_name='Controllers';
        description='Active Nexus controller'; device_ids=$nexusIds
    } | Out-Null
    Invoke-ApiPost 'save-group' @{
        group_id='all'; group_name='Active Fleet';
        description='Current live cluster'; device_ids=@($phoneIds + $nexusIds)
    } | Out-Null
}

$stateCommand = @'
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
pid="$(pgrep -x xmrig 2>/dev/null | head -1)"
echo "PID=$pid"
if [ -n "$pid" ]; then echo RUNNING=true; else echo RUNNING=false; fi
hr=0
if [ -f "$HOME/xmrig.log" ]; then
  hr="$(grep 'miner    speed' "$HOME/xmrig.log" 2>/dev/null | tail -1 | awk '{for(i=1;i<=NF;i++) if($i ~ /^10s\/60s\/15m$/){v=$(i+2); if(v ~ /^[0-9.]+$/) print v; else print 0; exit}}')"
fi
echo "HASHRATE=${hr:-0}"
if [ -x "$HOME/bin/xmrig" ]; then
  echo "BINHASH=$(sha256sum "$HOME/bin/xmrig" 2>/dev/null | awk '{print $1}')"
else
  echo BINHASH=
fi
'@

function Get-PhoneState($p) {
    $r = Invoke-Phone $p.IP $stateCommand
    if ($r.Exit -ne 0) { return $null }

    $joined = $r.Output -join "`n"
    $running = $joined -match '(?m)^RUNNING=true$'

    [double]$hr = 0
    if ($joined -match '(?m)^HASHRATE=([0-9.]+)$') {
        [void][double]::TryParse($Matches[1], [ref]$hr)
    }

    [int]$procId = 0
    if ($joined -match '(?m)^PID=(\d+)$') {
        $procId = [int]$Matches[1]
    }

    $hash = ''
    if ($joined -match '(?m)^BINHASH=([a-fA-F0-9]{64})$') {
        $hash = $Matches[1].ToLower()
    }

    return [pscustomobject]@{
        running = $running
        hashrate = $hr
        proc_id = $procId
        hash = $hash
        raw = $joined
    }
}

function Push-PhoneState($p) {
    $s = Get-PhoneState $p
    if (-not $s) { return $false }

    Invoke-ApiPost 'bridge-touch-device' @{
        hostname = $p.Hostname
        observed = @{
            xmrig_running = $s.running
            hashrate_60s = $s.hashrate
            custom_pid = $s.proc_id
            binary_hash = $s.hash
            agent_version = 'windows-bridge-2.1'
            workload_type = 'mining'
            workload_enabled = $s.running
            preflight_status = 'ok'
        }
    } | Out-Null
    return $true
}

function Get-DeviceForHost([string]$Hostname) {
    return @(Get-Devices) | Where-Object hostname -eq $Hostname | Select-Object -First 1
}

function Start-Phone($p, [bool]$Force=$false) {
    $d = Get-DeviceForHost $p.Hostname
    if (-not $d) { return [pscustomobject]@{ Exit=2; Output=@('DEVICE_NOT_REGISTERED') } }

    $ph = if ($d.desired.pool_url -and $d.desired.pool_url -ne '192.168.1.179') { [string]$d.desired.pool_url } else { $poolHost }
    if ($ph -notmatch '^[A-Za-z0-9._-]+$') { $ph = $poolHost }

    $pp = if ($d.desired.pool_port) { [int]$d.desired.pool_port } else { $poolPort }
    if ($pp -lt 1 -or $pp -gt 65535) { $pp = $poolPort }

    $threads = if ($d.desired.thread_count) { [int]$d.desired.thread_count } else { 6 }
    if ($threads -lt 1 -or $threads -gt 16) { $threads = 6 }

    $rx = if ($d.desired.randomx_mode) { [string]$d.desired.randomx_mode } else { 'light' }
    if ($rx -notin @('light','fast','auto')) { $rx = 'light' }

    $approved = if ($d.desired.approved_binary_hash -match '^[a-fA-F0-9]{64}$') { [string]$d.desired.approved_binary_hash } else { '' }
    $worker = "$wallet.$($p.Hostname)"
    $endpoint = "$ph`:$pp"
    $forceText = if ($Force) { '1' } else { '0' }

    $template = @'
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BIN="$HOME/bin/xmrig"
POOL='__POOL__'
WORKER='__WORKER__'
THREADS='__THREADS__'
RXMODE='__RXMODE__'
APPROVED='__APPROVED__'
FORCE='__FORCE__'
[ -x "$BIN" ] || { echo NO_BIN; exit 0; }
if [ -n "$APPROVED" ]; then
  ACTUAL="$(sha256sum "$BIN" 2>/dev/null | awk '{print $1}')"
  [ "$ACTUAL" = "$APPROVED" ] || { echo BLOCKED_BINARY_HASH_MISMATCH; exit 0; }
fi
OLD="$(pgrep -af xmrig 2>/dev/null | grep -v grep)"
if [ "$FORCE" != 1 ] && echo "$OLD" | grep -q "$WORKER" && echo "$OLD" | grep -q "$POOL"; then
  echo ALREADY_RUNNING_CORRECT
else
  pkill -9 xmrig 2>/dev/null || true
  sleep 1
  : > "$HOME/xmrig.log"
  nohup "$BIN" -o "$POOL" -u "$WORKER" -p x -k --threads="$THREADS" --randomx-mode="$RXMODE" --print-time=10 --log-file="$HOME/xmrig.log" --no-color >/dev/null 2>&1 &
  sleep 4
fi
pgrep -af xmrig 2>/dev/null | grep -v grep || echo NO_PROCESS
tail -20 "$HOME/xmrig.log" 2>/dev/null | grep -E 'miner    speed|new job|accepted|error' | tail -5 || true
'@

    $remote = $template.Replace('__POOL__',$endpoint).Replace('__WORKER__',$worker).Replace('__THREADS__',"$threads").Replace('__RXMODE__',$rx).Replace('__APPROVED__',$approved).Replace('__FORCE__',$forceText)
    return Invoke-Phone $p.IP $remote
}

function Stop-Phone($p) {
    $remote = @'
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
pkill -9 xmrig 2>/dev/null || true
sleep 1
pgrep -x xmrig >/dev/null && echo STILL_RUNNING || echo STOPPED
'@
    return Invoke-Phone $p.IP $remote
}

function Diagnose-Phone($p) {
    $remote = @'
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
echo "HOST=$(hostname 2>/dev/null)"
echo "USER=$(whoami 2>/dev/null)"
echo "UPTIME=$(uptime 2>/dev/null)"
echo "XMRIG=$(pgrep -x xmrig 2>/dev/null | tr '\n' ',')"
echo "SSHD=$(pgrep -x sshd 2>/dev/null | head -1)"
echo "BIN=$(test -x "$HOME/bin/xmrig" && echo READY || echo MISSING)"
echo "HASH=$(sha256sum "$HOME/bin/xmrig" 2>/dev/null | awk '{print $1}')"
tail -25 "$HOME/xmrig.log" 2>/dev/null || true
'@
    return Invoke-Phone $p.IP $remote
}

function Resolve-Targets([string]$Target) {
    if (-not $Target -or $Target -in @('all','phones')) { return @($phones) }
    if ($Target -match '^phone\d+$') { return @($phones | Where-Object Hostname -eq $Target) }

    $devices = @(Get-Devices)
    $d = $devices | Where-Object { $_.id -eq $Target -or $_.hostname -eq $Target } | Select-Object -First 1
    if ($d -and $d.hostname -like 'phone*') {
        return @($phones | Where-Object Hostname -eq $d.hostname)
    }
    return @()
}

function Apply-Desired($p, [bool]$Force=$false) {
    $d = Get-DeviceForHost $p.Hostname
    if (-not $d) { return }

    [int64]$updated = 0
    if ($d.desired -and $d.desired.updated_at) {
        [void][int64]::TryParse("$($d.desired.updated_at)", [ref]$updated)
    }
    if (-not $Force -and $updated -lt $bridgeStartMs) { return }

    $enabled = $false
    if (-not $d.quarantined -and $d.desired) {
        if ($null -ne $d.desired.miner_enabled) { $enabled = [bool]$d.desired.miner_enabled }
        elseif ($null -ne $d.desired.workload_enabled) { $enabled = [bool]$d.desired.workload_enabled }
    }

    $s = Get-PhoneState $p
    if (-not $s) { return }

    if ($enabled -and (-not $s.running -or $Force)) {
        Start-Phone $p $Force | Out-Null
    }
    elseif (-not $enabled -and $s.running) {
        Stop-Phone $p | Out-Null
    }
}

function Process-Command {
    $c = Invoke-ApiGet 'commands'
    if (-not $c -or -not $c.queue -or @($c.queue).Count -eq 0) { return $false }

    $cmd = @($c.queue)[0]
    $type = [string]$cmd.type
    $targets = @(Resolve-Targets ([string]$cmd.target))
    $output = New-Object System.Collections.Generic.List[string]

    if ($targets.Count -eq 0) {
        $output.Add("TARGET_UNAVAILABLE: $($cmd.target)")
    }

    foreach ($p in $targets) {
        switch -Regex ($type) {
            '^(mining-start|fresh-connect|start)$' { $r = Start-Phone $p $false; break }
            '^restart$' { $r = Start-Phone $p $true; break }
            '^(mining-stop|stop|kill-rogue)$' { $r = Stop-Phone $p; break }
            '^(mining-status|verify-all|status|fetch-logs)$' {
                $s = Get-PhoneState $p
                $r = [pscustomobject]@{ Exit=0; Output=@($(if ($s) { $s.raw } else { 'UNREACHABLE' })) }
                break
            }
            '^run-diagnostic$' { $r = Diagnose-Phone $p; break }
            '^reconcile$' {
                Apply-Desired $p $true
                $s = Get-PhoneState $p
                $r = [pscustomobject]@{ Exit=0; Output=@($(if ($s) { $s.raw } else { 'UNREACHABLE' })) }
                break
            }
            '^reset-restart-count$' { $r = [pscustomobject]@{ Exit=0; Output=@('RESET_OK') }; break }
            '^reboot$' { $r = [pscustomobject]@{ Exit=0; Output=@('REBOOT_SKIPPED_SAFETY') }; break }
            default { $r = [pscustomobject]@{ Exit=2; Output=@("UNSUPPORTED $type") } }
        }

        $output.Add("===== $($p.Hostname) / $type =====")
        foreach ($line in @($r.Output)) { $output.Add("$line") }
        Push-PhoneState $p | Out-Null
    }

    Invoke-ApiPost 'bridge-complete' @{
        id = $cmd.id
        target = $cmd.target
        type = $type
        result_summary = "completed $type -> $($cmd.target)"
        output = ($output -join "`n")
    } | Out-Null

    Write-Log "Completed command $($cmd.id): $type -> $($cmd.target)"
    return $true
}

Write-Log "Starting Windows bridge. API=$api"
Invoke-ApiPost 'bridge-heartbeat' @{
    hostname = $env:COMPUTERNAME
    summary = 'Windows live bridge starting'
} | Out-Null

Reconcile-Registry
Write-Log "Windows bridge online. Fleet: $($phones.IP -join ', ')"
$lastRefresh = [DateTime]::MinValue

while ($true) {
    try {
        Invoke-ApiPost 'bridge-heartbeat' @{
            hostname = $env:COMPUTERNAME
            summary = 'Windows live bridge polling current eight-phone fleet'
        } | Out-Null

        $didWork = Process-Command

        if ((Get-Date) - $lastRefresh -gt [TimeSpan]::FromSeconds(30)) {
            foreach ($p in $phones) {
                Apply-Desired $p $false
                Push-PhoneState $p | Out-Null
            }
            $lastRefresh = Get-Date
        }

        Start-Sleep -Seconds $(if ($didWork) { 1 } else { 3 })
    }
    catch {
        Write-Log "Loop error: $($_.Exception.Message)"
        Start-Sleep -Seconds 5
    }
}
