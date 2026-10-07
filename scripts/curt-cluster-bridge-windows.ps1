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
$swarmApi = 'https://curtbrag.com/api/cluster'
$bridgeVersion = '2.5.0'
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

function Invoke-Phone([string]$IP, [string]$Remote, [string]$User=$phoneUser, [int]$Port=$phonePort) {
    $args = @(
        '-n', '-p', "$Port",
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
        "$User@$IP",
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
[ -n "$pid" ] || hr=0
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
attempt=0
while [ "$attempt" -lt 6 ]; do
  if ! pgrep -x xmrig >/dev/null 2>&1; then echo STOPPED; exit 0; fi
  sleep 1
  attempt=$((attempt + 1))
done
echo STILL_RUNNING
exit 1
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

# All network probes begin together; one unreachable device cannot delay the rest.
function Get-FleetConnections {
    $roster = @($phones | ForEach-Object { [pscustomobject]@{Name=$_.Hostname;IP=$_.IP;Port=$phonePort} }) + @(
        [pscustomobject]@{Name='Alina';IP='192.168.1.193';Port=22},
        [pscustomobject]@{Name='Nexus';IP='192.168.1.192';Port=22},
        [pscustomobject]@{Name='SteamDeck';IP='192.168.1.166';Port=22},
        [pscustomobject]@{Name='viki';IP='192.168.1.239';Port=22}
    )
    $probes = @($roster | ForEach-Object {
        $client = [Net.Sockets.TcpClient]::new()
        [pscustomobject]@{Node=$_;Client=$client;Pending=$client.BeginConnect($_.IP,$_.Port,$null,$null)}
    })
    $deadline = (Get-Date).AddSeconds(4)
    $rows = @($probes | ForEach-Object {
        $open = $false
        try {
            $remaining = [Math]::Max(0,[int]($deadline-(Get-Date)).TotalMilliseconds)
            if ($_.Pending.AsyncWaitHandle.WaitOne($remaining)) { $_.Client.EndConnect($_.Pending); $open=$_.Client.Connected }
        } catch {} finally { $_.Pending.AsyncWaitHandle.Close(); $_.Client.Dispose() }
        [pscustomobject]@{name=$_.Node.Name;ip=$_.Node.IP;port=$_.Node.Port;reachable=$open}
    })
    $rows += [pscustomobject]@{name='RenderRig';ip=$env:COMPUTERNAME;port=0;reachable=$true}
    return [pscustomobject]@{checked_at=[DateTimeOffset]::UtcNow.ToString('o');devices=$rows}
}

$pcWorkers = @(
    [pscustomobject]@{Hostname='Alina';IP='192.168.1.193';User='neo';Port=22},
    [pscustomobject]@{Hostname='Nexus';IP='192.168.1.192';User='neo';Port=22},
    [pscustomobject]@{Hostname='SteamDeck';IP='192.168.1.166';User='deck';Port=22},
    [pscustomobject]@{Hostname='viki';IP='192.168.1.239';User='neo';Port=22}
)
function Discover-PhoneAddresses {
    $found = @()
    # Scan only the configured home subnet and Termux SSH port. Candidates do
    # not replace roster addresses until device identity can be verified.
    for ($base=1; $base -le 254; $base+=32) {
        $probes = @($base..([Math]::Min(254,$base+31)) | ForEach-Object {
            $ip="192.168.1.$_"; $client=[Net.Sockets.TcpClient]::new()
            [pscustomobject]@{IP=$ip;Client=$client;Pending=$client.BeginConnect($ip,$phonePort,$null,$null)}
        })
        $deadline=(Get-Date).AddSeconds(2)
        foreach ($probe in $probes) {
            try {
                $remaining=[Math]::Max(0,[int]($deadline-(Get-Date)).TotalMilliseconds)
                if ($probe.Pending.AsyncWaitHandle.WaitOne($remaining)) {
                    $probe.Client.EndConnect($probe.Pending)
                    if ($probe.Client.Connected) { $found += $probe.IP }
                }
            } catch {} finally { $probe.Pending.AsyncWaitHandle.Close(); $probe.Client.Dispose() }
        }
    }
    $output=@('Termux SSH candidates on 192.168.1.0/24; identity must be verified before updating addresses.')
    foreach ($ip in $found) {
        $known=$phones | Where-Object IP -eq $ip | Select-Object -First 1
        $output += "$($ip):$phonePort " + $(if($known){"configured $($known.Hostname)"}else{'unmapped candidate'})
    }
    if (-not $found.Count) { $output += 'No open Termux SSH ports found.' }
    return $output -join "`n"
}
function Diagnose-FleetWorkers {
    $remote = @'
printf 'SSH_AUTH=OK HOST=%s USER=%s\n' "$(hostname)" "$(whoami)"
SCRIPT="$HOME/node-swarm.sh"
if [ -s "$SCRIPT" ]; then sh -n "$SCRIPT" && echo WORKER_SCRIPT=OK; else echo WORKER_SCRIPT=MISSING; fi
count=0
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  if tr '\000' '\n' < "$proc/cmdline" | grep -Fqx "$SCRIPT"; then echo "WORKER_PID=${proc##*/}"; count=$((count+1)); fi
done
printf 'WORKER_COUNT=%s\n' "$count"
if [ -f "$HOME/cluster/state/pending-result.json" ]; then printf 'PENDING_RESULT_BYTES='; wc -c < "$HOME/cluster/state/pending-result.json"; fi
tail -n 4 "$HOME/cluster/logs/swarm-agent.log" 2>/dev/null || true
'@
    $output = @()
    foreach ($p in $phones) {
        $result = Invoke-Phone $p.IP $remote
        $output += "=== $($p.Hostname) exit=$($result.Exit) ===`n$(@($result.Output) -join "`n")"
    }
    foreach ($p in $pcWorkers) {
        $result = Invoke-Phone $p.IP $remote $p.User $p.Port
        $output += "=== $($p.Hostname) exit=$($result.Exit) ===`n$(@($result.Output) -join "`n")"
    }
    $output += '=== RenderRig === Local bridge running; GPU worker heartbeat shown in dashboard.'
    return $output -join "`n"
}
function Recover-OfflinePcWorkers {
    $nodes = @(Get-SwarmNodes)
    $output = @()
    $failed = 0
    foreach ($p in $pcWorkers) {
        $node = $nodes | Where-Object id -eq $p.Hostname | Select-Object -First 1
        if (-not $node) { $output += "$($p.Hostname): missing roster entry; skipped"; $failed++; continue }
        if ($node.online -eq $true) { $output += "$($p.Hostname): online; skipped"; continue }
        $remote = @'
SCRIPT="$HOME/node-swarm.sh"
[ -s "$SCRIPT" ] || { echo WORKER_MISSING; exit 2; }
sh -n "$SCRIPT" || exit 2
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  if tr '\000' '\n' < "$proc/cmdline" | grep -Fqx "$SCRIPT"; then echo "EXISTING_WORKER_PID=${proc##*/}; run diagnostics for stalled heartbeat"; exit 3; fi
done
mkdir -p "$HOME/cluster/logs" "$HOME/cluster/state"
DEVICE_ID='__DEVICE__' NODE_CLASS='pc' SWARM_URL='https://curtbrag.com/api/cluster' POLL_INTERVAL='60' nohup sh "$SCRIPT" >> "$HOME/cluster/logs/swarm-agent.log" 2>&1 </dev/null &
sleep 3
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  if tr '\000' '\n' < "$proc/cmdline" | grep -Fqx "$SCRIPT"; then echo "STARTED_PID=${proc##*/}"; exit 0; fi
done
echo START_FAILED
exit 1
'@
        $result = Invoke-Phone $p.IP ($remote.Replace('__DEVICE__',$p.Hostname)) $p.User $p.Port
        if ($result.Exit -ne 0) { $failed++ }
        $output += "$($p.Hostname): exit=$($result.Exit) $(@($result.Output) -join ' ')"
    }
    return [pscustomobject]@{Failed=($failed -gt 0);Output=($output -join "`n");Summary="PC recovery completed; $failed failures. Allow 60 seconds for heartbeats."}
}

function Get-SwarmNodes {
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $status = Invoke-RestMethod -Uri "$($swarmApi)?action=queue-status&_=$stamp" -Headers $headers -Method Get -TimeoutSec 20
    if (-not $status.nodes -or @($status.nodes).Count -lt $phones.Count) {
        throw 'Swarm API did not return the phone roster; recovery was not started.'
    }
    return @($status.nodes)
}

function Recover-PhoneSwarm($p) {
    # Only the fixed phone roster supplies these replacements. The command queue
    # cannot provide a URL, script body, or arbitrary shell command.
    $boot = @'
#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
mkdir -p "$HOME/cluster/logs" "$HOME/cluster/state"
if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock >/dev/null 2>&1 || true; fi
sshd >/dev/null 2>&1 || true
if [ -f "$HOME/node-swarm.sh" ]; then
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    if tr '\000' '\n' < "$proc/cmdline" | grep -Fqx "$HOME/node-swarm.sh"; then exit 0; fi
  done
  DEVICE_ID='__DEVICE__' NODE_CLASS='worker' SWARM_URL='https://curtbrag.com/api/cluster' POLL_INTERVAL='60' nohup sh "$HOME/node-swarm.sh" >> "$HOME/cluster/logs/swarm-agent.log" 2>&1 </dev/null &
fi
'@
    $boot = $boot.Replace('__DEVICE__', $p.Hostname)
    $encodedBoot = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($boot))
    $remote = @'
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
SCRIPT="$HOME/node-swarm.sh"
[ -s "$SCRIPT" ] || { echo WORKER_MISSING; exit 2; }
sh -n "$SCRIPT" || { echo WORKER_PARSE_FAILED; exit 2; }
mkdir -p "$HOME/cluster/logs" "$HOME/cluster/state" "$HOME/.termux/boot"
printf %s '__BOOT__' | base64 -d > "$HOME/.termux/boot/10-curt-swarm.tmp" || exit 2
sh -n "$HOME/.termux/boot/10-curt-swarm.tmp" || exit 2
chmod 700 "$HOME/.termux/boot/10-curt-swarm.tmp"
mv "$HOME/.termux/boot/10-curt-swarm.tmp" "$HOME/.termux/boot/10-curt-swarm" || exit 2
if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock >/dev/null 2>&1 || true; fi
worker_pids() {
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    if tr '\000' '\n' < "$proc/cmdline" | grep -Fqx "$SCRIPT"; then printf '%s\n' "${proc##*/}"; fi
  done
}
# This phone was offline in the API. Stop only its exact swarm script processes,
# including duplicates or a worker whose PID file is stale.
old="$(worker_pids)"
if [ -n "$old" ]; then
  for pid in $old; do kill "$pid" 2>/dev/null || true; done
  tries=0
  while [ -n "$(worker_pids)" ] && [ "$tries" -lt 8 ]; do sleep 1; tries=$((tries + 1)); done
  if [ -n "$(worker_pids)" ]; then echo WORKER_STOP_FAILED; exit 1; fi
fi
DEVICE_ID='__DEVICE__' NODE_CLASS='worker' SWARM_URL='https://curtbrag.com/api/cluster' POLL_INTERVAL='60' nohup sh "$SCRIPT" >> "$HOME/cluster/logs/swarm-agent.log" 2>&1 </dev/null &
sleep 3
active="$(worker_pids)"
if [ -z "$active" ]; then
  echo WORKER_START_FAILED
  tail -n 4 "$HOME/cluster/logs/swarm-agent.log" 2>/dev/null || true
  exit 1
fi
if [ "$(printf '%s\n' "$active" | wc -l)" -ne 1 ]; then echo WORKER_DUPLICATE; exit 1; fi
printf 'RUNNING PID=%s BOOT_SCRIPT_READY\n' "$active"
'@
    return Invoke-Phone $p.IP ($remote.Replace('__BOOT__', $encodedBoot).Replace('__DEVICE__', $p.Hostname))
}

function Recover-OfflinePhoneSwarm([string]$Target) {
    $results = New-Object System.Collections.Generic.List[string]
    $targets = if ($Target -eq 'phones') { @($phones) } else { @($phones | Where-Object Hostname -eq $Target) }
    if ($targets.Count -eq 0) { return [pscustomobject]@{ Failed=$true; Summary='Invalid phone recovery target'; Output='TARGET_UNAVAILABLE' } }
    try { $nodes = @(Get-SwarmNodes) }
    catch { return [pscustomobject]@{ Failed=$true; Summary='Swarm status unavailable'; Output=$_.Exception.Message } }

    $attempted = 0
    $started = 0
    $failed = 0
    foreach ($p in $targets) {
        $node = $nodes | Where-Object id -eq $p.Hostname | Select-Object -First 1
        if (-not $node) { $results.Add("$($p.Hostname): missing from Swarm status"); $failed++; continue }
        if ($node.online -eq $true) { $results.Add("$($p.Hostname): already online; skipped"); continue }
        try { $latest = @(Get-SwarmNodes) | Where-Object id -eq $p.Hostname | Select-Object -First 1 }
        catch { $results.Add("$($p.Hostname): could not recheck Swarm status"); $failed++; continue }
        if (-not $latest) { $results.Add("$($p.Hostname): missing from fresh Swarm status"); $failed++; continue }
        if ($latest.online -eq $true) { $results.Add("$($p.Hostname): back online; skipped"); continue }
        $attempted++
        $r = Recover-PhoneSwarm $p
        $resultText = (@($r.Output) -join ' ').Trim()
        $results.Add("$($p.Hostname): exit=$($r.Exit) $resultText")
        if ($r.Exit -eq 0 -and $resultText -match 'RUNNING|ALREADY_RUNNING') { $started++ }
        else { $failed++ }
    }
    return [pscustomobject]@{
        Failed = ($failed -gt 0)
        Summary = "Swarm recovery: $started/$attempted offline phones started; $failed failed. Heartbeats may take 60 seconds."
        Output = ($results -join "`n")
    }
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

function Get-PhoneControllerRemaining($Watch) {
    $remaining = 10000 - [int]$Watch.ElapsedMilliseconds
    if ($remaining -le 0) { throw 'CONTROLLER_DEADLINE' }
    return $remaining
}

function Read-PhoneControllerExact([IO.Stream]$Stream, [int]$Count, $Watch) {
    if ($Count -lt 0 -or $Count -gt 65536) { throw 'CONTROLLER_SIZE_LIMIT' }
    $bytes = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $remaining = Get-PhoneControllerRemaining $Watch
        if ($Stream.CanTimeout) { $Stream.ReadTimeout = $remaining }
        $read = $Stream.Read($bytes, $offset, $Count - $offset)
        if ($read -le 0) { throw 'CONTROLLER_PARTIAL_REPLY' }
        $offset += $read
    }
    return ,$bytes
}

function Write-PhoneControllerService([IO.Stream]$Stream, [string]$Service, $Watch) {
    $payload = [Text.Encoding]::ASCII.GetBytes($Service)
    if ($payload.Length -eq 0 -or $payload.Length -gt 4096) { throw 'CONTROLLER_SERVICE_LIMIT' }
    $remaining = Get-PhoneControllerRemaining $Watch
    if ($Stream.CanTimeout) { $Stream.WriteTimeout = $remaining }
    $prefix = [Text.Encoding]::ASCII.GetBytes(('{0:x4}' -f $payload.Length))
    $Stream.Write($prefix, 0, $prefix.Length)
    $remaining = Get-PhoneControllerRemaining $Watch
    if ($Stream.CanTimeout) { $Stream.WriteTimeout = $remaining }
    $Stream.Write($payload, 0, $payload.Length)
}

function Read-PhoneControllerString([IO.Stream]$Stream, $Watch) {
    $header = [Text.Encoding]::ASCII.GetString((Read-PhoneControllerExact $Stream 4 $Watch))
    if ($header -cnotmatch '^[0-9a-fA-F]{4}$') { throw 'CONTROLLER_BAD_LENGTH' }
    $length = [Convert]::ToInt32($header, 16)
    return [Text.Encoding]::UTF8.GetString((Read-PhoneControllerExact $Stream $length $Watch))
}

function Read-PhoneControllerStatus([IO.Stream]$Stream, $Watch) {
    $status = [Text.Encoding]::ASCII.GetString((Read-PhoneControllerExact $Stream 4 $Watch))
    if ($status -ceq 'OKAY') { return }
    if ($status -ceq 'FAIL') { $null = Read-PhoneControllerString $Stream $Watch }
    throw 'CONTROLLER_REJECTED_REQUEST'
}

function Read-PhoneControllerShell([IO.Stream]$Stream, $Watch) {
    $stdout = New-Object IO.MemoryStream
    $stderr = New-Object IO.MemoryStream
    $total = 0
    try {
        while ($true) {
            $header = Read-PhoneControllerExact $Stream 5 $Watch
            $length = [BitConverter]::ToUInt32($header, 1)
            if ($length -gt 65536 -or ($total + $length) -gt 65536) { throw 'CONTROLLER_SIZE_LIMIT' }
            $total += $length
            $payload = Read-PhoneControllerExact $Stream ([int]$length) $Watch
            switch ($header[0]) {
                1 { $stdout.Write($payload, 0, $payload.Length) }
                2 { $stderr.Write($payload, 0, $payload.Length) }
                3 {
                    if ($length -ne 1) { throw 'CONTROLLER_BAD_EXIT_PACKET' }
                    return [pscustomobject]@{
                        ExitCode = [int]$payload[0]
                        Output = [Text.Encoding]::UTF8.GetString($stdout.ToArray())
                        ErrorOutput = [Text.Encoding]::UTF8.GetString($stderr.ToArray())
                    }
                }
                default { throw 'CONTROLLER_BAD_SHELL_PACKET' }
            }
        }
    } finally { $stdout.Dispose(); $stderr.Dispose() }
}

function Get-FixedPhoneControllerShell([string]$Operation) {
    if ($Operation -ceq 'return') {
        return 'am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.termux/.app.TermuxActivity -f 0x10000000'
    }
    if ($Operation -ceq 'foreground') {
        # Filter on the phone. No activity records, titles or other app names
        # cross the socket. A single top-resumed record takes precedence.
        return @'
dumpsys activity activities 2>/dev/null | { top=0; top_termux=0; resumed=0; resumed_termux=0; while IFS= read -r line; do case "$line" in *"topResumedActivity="*|*"topResumedActivity:"*) top=$((top+1)); case "$line" in *" com.termux/"*) top_termux=$((top_termux+1));; esac;; *"mResumedActivity="*|*"mResumedActivity:"*) resumed=$((resumed+1)); case "$line" in *" com.termux/"*) resumed_termux=$((resumed_termux+1));; esac;; esac; done; if { [ "$top" -eq 1 ] && [ "$top_termux" -eq 1 ]; } || { [ "$top" -eq 0 ] && [ "$resumed" -eq 1 ] && [ "$resumed_termux" -eq 1 ]; }; then printf 'TERMUX_RESUMED\n'; else printf 'TERMUX_NOT_RESUMED\n'; fi; }
'@
    }
    throw 'CONTROLLER_OPERATION_UNAVAILABLE'
}

function Test-PhoneControllerOverrides {
    foreach ($name in @('ADB_VENDOR_KEYS','ANDROID_USER_HOME','ANDROID_SDK_HOME','ADB_SERVER_SOCKET','ADB_SERVER_PORT','ANDROID_ADB_SERVER_PORT')) {
        if ([Environment]::GetEnvironmentVariable($name)) { return $true }
    }
    return $false
}

function Invoke-ExistingPhoneController([string]$Operation, [string]$Transport='', $DeadlineWatch=$null) {
    if ($Operation -cnotin @('devices','discovery','return','foreground')) { throw 'CONTROLLER_OPERATION_UNAVAILABLE' }
    $shell = $Operation -cin @('return','foreground')
    if ($shell -and $Transport -cnotmatch '^[A-Za-z0-9._:-]{1,200}$') { throw 'CONTROLLER_TRANSPORT_INVALID' }
    if (-not $shell -and $Transport) { throw 'CONTROLLER_TRANSPORT_INVALID' }
    $command = if ($shell) { Get-FixedPhoneControllerShell $Operation } else { $null }
    $ownWatch = $null -eq $DeadlineWatch
    $watch = if ($ownWatch) { [Diagnostics.Stopwatch]::StartNew() } else { $DeadlineWatch }
    $client = [Net.Sockets.TcpClient]::new()
    $pending = $null
    try {
        # A socket request cannot start, reset, pair or connect an ADB server.
        $null = Get-PhoneControllerRemaining $watch
        $pending = $client.BeginConnect('127.0.0.1', 5037, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne((Get-PhoneControllerRemaining $watch))) { throw 'CONTROLLER_DEADLINE' }
        $client.EndConnect($pending)
        $stream = $client.GetStream()
        if (-not $shell) {
            $service = if ($Operation -ceq 'devices') { 'host:devices-l' } else { 'host:mdns:services' }
            Write-PhoneControllerService $stream $service $watch
            Read-PhoneControllerStatus $stream $watch
            return Read-PhoneControllerString $stream $watch
        }
        Write-PhoneControllerService $stream ('host:transport:' + $Transport) $watch
        Read-PhoneControllerStatus $stream $watch
        Write-PhoneControllerService $stream ('shell,v2,raw:' + $command) $watch
        Read-PhoneControllerStatus $stream $watch
        $closeInput = [byte[]]@(4,0,0,0,0)
        $stream.WriteTimeout = Get-PhoneControllerRemaining $watch
        $stream.Write($closeInput, 0, $closeInput.Length)
        return Read-PhoneControllerShell $stream $watch
    } finally {
        if ($pending) { $pending.AsyncWaitHandle.Close() }
        $client.Dispose()
        if ($ownWatch) { $watch.Stop() }
    }
}

function Resolve-PhoneControllerTransport([string]$Unit, [string]$Devices, [string]$Discovery) {
    $ips = @{ phone173='192.168.1.173'; phone174='192.168.1.174'; phone176='192.168.1.176'; phone177='192.168.1.177'; phone191='192.168.1.191'; phone195='192.168.1.195'; phone253='192.168.1.253'; phone254='192.168.1.254' }
    if ($Unit -cnotin @($ips.Keys)) { throw 'CONTROLLER_TARGET_INVALID' }
    $ip = $ips[$Unit]
    $names = @{}
    foreach ($line in ($Discovery -split "`n")) {
        if ($line -cmatch '^\s*([A-Za-z0-9._-]{1,200})\s+_adb-tls-connect\._tcp\.?\s+(192\.168\.1\.\d{1,3}):(\d{1,5})\s*$') {
            $name = $Matches[1].TrimEnd('.')
            $address = $Matches[2]
            $port = [int]$Matches[3]
            if ($port -lt 1 -or $port -gt 65535) { continue }
            foreach ($alias in @($name, ($name -creplace '\._adb-tls-connect\._tcp$', '')) | Select-Object -Unique) {
                if (-not $names.ContainsKey($alias)) { $names[$alias] = @() }
                $names[$alias] = @($names[$alias]) + $address
            }
        }
    }
    $matching = @()
    foreach ($line in ($Devices -split "`n")) {
        if ($line -cnotmatch '^([A-Za-z0-9._:-]{1,200})\s+(device|offline|unauthorized)\b') { continue }
        $serial = $Matches[1]
        $state = $Matches[2]
        $matched = $false
        if ($serial -cmatch '^192\.168\.1\.\d{1,3}:(\d{1,5})$') {
            $port = [int]$Matches[1]
            $matched = $port -ge 1 -and $port -le 65535 -and $serial.StartsWith($ip + ':', [StringComparison]::Ordinal)
        } else {
            $alias = $serial.TrimEnd('.') -creplace '\._adb-tls-connect\._tcp$', ''
            if ($names.ContainsKey($alias)) {
                $addresses = @($names[$alias] | Select-Object -Unique)
                if ($addresses.Count -gt 1 -and $ip -cin $addresses) { throw 'CONTROLLER_TRANSPORT_AMBIGUOUS' }
                $matched = $addresses.Count -eq 1 -and $addresses[0] -ceq $ip
            }
        }
        if ($matched) { $matching += [pscustomobject]@{ Serial=$serial; State=$state } }
    }
    $authorized = @($matching | Where-Object State -CEQ 'device' | Sort-Object Serial -Unique)
    if ($authorized.Count -gt 1) { throw 'CONTROLLER_TRANSPORT_AMBIGUOUS' }
    if ($authorized.Count -eq 1) { return [pscustomobject]@{ Transport=$authorized[0].Serial; ControllerState='connected' } }
    $state = if (@($matching | Where-Object State -CEQ 'unauthorized').Count -gt 0) { 'unauthorized' } else { 'disconnected' }
    return [pscustomobject]@{ Transport=$null; ControllerState=$state }
}

function Invoke-PhoneControllerReturn($Command) {
    $unit = [string]$Command.target
    $report = [ordered]@{ kind='phone-controller-return'; unit=$unit; state='failed'; foreground_app_verified=$false; visible_screen_verified=$false; error=$null; controller_state='disconnected' }
    try {
        if ($unit -cnotin @('phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254')) { throw 'CONTROLLER_TARGET_INVALID' }
        foreach ($name in @('payload','cmd','command','url','serial','component','flags','settings')) {
            $property = $Command.PSObject.Properties[$name]
            if ($property -and $null -ne $property.Value) {
                $value = $property.Value
                if ($name -ceq 'payload' -and (($value -is [Collections.IDictionary] -and $value.Count -eq 0) -or ($value -is [pscustomobject] -and @($value.PSObject.Properties).Count -eq 0))) { continue }
                throw 'CONTROLLER_PAYLOAD_INVALID'
            }
        }
        if (Test-PhoneControllerOverrides) { throw 'CONTROLLER_OVERRIDE_PRESENT' }
        $devices = [string](Invoke-ExistingPhoneController 'devices')
        $discovery = ''
        if ($devices -match '(?m)^(?!192\.168\.1\.\d+:)[A-Za-z0-9._:-]+\s+(device|offline|unauthorized)\b') {
            try { $discovery = [string](Invoke-ExistingPhoneController 'discovery') } catch {}
        }
        $resolved = Resolve-PhoneControllerTransport $unit $devices $discovery
        $report.controller_state = $resolved.ControllerState
        if (-not $resolved.Transport) {
            $report.error = 'No already-authorized controller connection for this phone. Reconnect its existing wireless debugging connection before trying again.'
            return [pscustomobject]$report
        }
        $started = Invoke-ExistingPhoneController 'return' $resolved.Transport
        $raw = [string]$started.Output + "`n" + [string]$started.ErrorOutput
        if ($started.ExitCode -ne 0 -or $raw -match '(?im)^\s*error(?:\s|:|$)|exception|permission denial|no activity found|unable to resolve intent|background activity start[^\n]*(denied|blocked|not allowed)') { throw 'CONTROLLER_ACTIVITY_REJECTED' }
        # am may finish before Android updates its resumed activity. Observe
        # at most three times within one shared ten-second deadline, while
        # keeping the activity request itself strictly one shot.
        $observation = [Diagnostics.Stopwatch]::StartNew()
        $confirmed = $false
        try {
            for ($attempt=0; $attempt -lt 3; $attempt++) {
                if ($attempt -gt 0) {
                    if ((Get-PhoneControllerRemaining $observation) -le 250) { throw 'CONTROLLER_FOREGROUND_UNCONFIRMED' }
                    Start-Sleep -Milliseconds 250
                }
                $foreground = Invoke-ExistingPhoneController 'foreground' $resolved.Transport $observation
                if ($foreground.ExitCode -ne 0 -or ([string]$foreground.ErrorOutput).Trim()) { throw 'CONTROLLER_FOREGROUND_UNCONFIRMED' }
                if (([string]$foreground.Output).Trim() -ceq 'TERMUX_RESUMED') { $confirmed=$true; break }
            }
        } finally { $observation.Stop() }
        if (-not $confirmed) { throw 'CONTROLLER_FOREGROUND_UNCONFIRMED' }
        $report.state = 'termux-foreground'
        $report.foreground_app_verified = $true
    } catch {
        switch -Exact ($_.Exception.Message) {
            'CONTROLLER_TARGET_INVALID' { $report.error = 'Choose one of the eight configured phones.' }
            'CONTROLLER_PAYLOAD_INVALID' { $report.error = 'This action accepts only the fixed return-to-Termux request.' }
            'CONTROLLER_OVERRIDE_PRESENT' { $report.error = 'Controller overrides are present; the existing default controller was not used.' }
            'CONTROLLER_TRANSPORT_AMBIGUOUS' { $report.controller_state='failed'; $report.error = 'More than one matching controller connection was found; no activity was opened.' }
            'CONTROLLER_ACTIVITY_REJECTED' { $report.error = 'Android rejected the fixed Termux activity request.' }
            'CONTROLLER_FOREGROUND_UNCONFIRMED' { $report.error = 'Android did not confirm Termux as the foreground app. The return remains unconfirmed.' }
            default { $report.error = 'The existing controller connection was unavailable, refused the request, or timed out. No new connection or authorization was attempted.' }
        }
    }
    return [pscustomobject]$report
}

function Process-Command {
    $c = Invoke-ApiGet 'commands'
    if (-not $c -or -not $c.queue -or @($c.queue).Count -eq 0) { return $false }

    $cmd = @($c.queue)[0]
    $type = [string]$cmd.type
    if ($type -ceq 'phone-return-termux') {
        $report = Invoke-PhoneControllerReturn $cmd
        $verified = $report.state -ceq 'termux-foreground' -and $report.foreground_app_verified -eq $true
        Invoke-ApiPost 'bridge-complete' @{
            id=$cmd.id; target=$cmd.target; type=$type
            status=$(if($verified){'completed'}else{'failed'})
            result_summary=$(if($verified){'Android confirms Termux in the foreground; physical screen unverified.'}else{'Return to Termux failed or remains unconfirmed.'})
            output=($report | ConvertTo-Json -Depth 3 -Compress)
        } | Out-Null
        return $true
    }
    if ($type -in @('fleet-diagnose','swarm-recover-pcs','fleet-discover')) {
        try {
            if ($type -eq 'fleet-discover') { $output=Discover-PhoneAddresses; $failed=$false; $summary='Phone SSH address discovery completed' }
            elseif ($type -eq 'fleet-diagnose') { $output = Diagnose-FleetWorkers; $failed=$false; $summary='SSH and worker diagnostics for all 13 devices' }
            else { $r=Recover-OfflinePcWorkers; $output=$r.Output; $failed=$r.Failed; $summary=$r.Summary }
        } catch { $output=$_.Exception.Message; $failed=$true; $summary='Fleet operation failed' }
        Invoke-ApiPost 'bridge-complete' @{id=$cmd.id;target=$cmd.target;type=$type;status=$(if($failed){'failed'}else{'completed'});result_summary=$summary;output=$output} | Out-Null
        return $true
    }
    if ($type -eq 'fleet-check') {
        $script:fleetConnections = Get-FleetConnections
        $text = ($script:fleetConnections.devices | ForEach-Object { "$($_.name): $($_.ip):$($_.port) " + $(if ($_.port -eq 0) {'LOCAL BRIDGE OK'} elseif ($_.reachable) {'SSH PORT OPEN'} else {'SSH PORT UNREACHABLE'}) }) -join "`n"
        Invoke-ApiPost 'bridge-complete' @{id=$cmd.id;target=$cmd.target;type=$type;status='completed';result_summary='All 13 devices checked';output=$text} | Out-Null
        Invoke-ApiPost 'bridge-heartbeat' @{hostname=$env:COMPUTERNAME;bridge_version=$bridgeVersion;fleet_connections=$script:fleetConnections;summary='Fleet connection check completed'} | Out-Null
        return $true
    }
    if ($type -eq 'swarm-recover') {
        $recovery = Recover-OfflinePhoneSwarm ([string]$cmd.target)
        $completed = Invoke-ApiPost 'bridge-complete' @{
            id = $cmd.id; target = $cmd.target; type = $type
            status = if ($recovery.Failed) { 'failed' } else { 'completed' }
            result_summary = $recovery.Summary; output = $recovery.Output
        }
        if (-not $completed) { Write-Log "Could not report swarm recovery $($cmd.id); retry is safe." }
        else { Write-Log "$($recovery.Summary) Command $($cmd.id)" }
        return $true
    }
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
    bridge_version = $bridgeVersion
    summary = 'Windows live bridge starting'
} | Out-Null

Reconcile-Registry
Write-Log "Windows bridge online. Fleet: $($phones.IP -join ', ')"
$lastRefresh = [DateTime]::MinValue
$lastHeartbeat = Get-Date

$fleetConnections = $null
$lastFleetCheck = [DateTime]::MinValue
while ($true) {
    try {
        if ((Get-Date) - $lastFleetCheck -gt [TimeSpan]::FromMinutes(5)) {
            $fleetConnections = Get-FleetConnections
            $lastFleetCheck = Get-Date
        }
        if ((Get-Date) - $lastHeartbeat -gt [TimeSpan]::FromSeconds(30)) {
            Invoke-ApiPost 'bridge-heartbeat' @{
                hostname = $env:COMPUTERNAME
                bridge_version = $bridgeVersion
                summary = 'Windows live bridge polling 13-device fleet'
                fleet_connections = $fleetConnections
            } | Out-Null
            $lastHeartbeat = Get-Date
        }

        $didWork = Process-Command

        if ((Get-Date) - $lastRefresh -gt [TimeSpan]::FromSeconds(90)) {
            foreach ($p in $phones) {
                Apply-Desired $p $false
                Push-PhoneState $p | Out-Null
            }
            $lastRefresh = Get-Date
        }

        Start-Sleep -Seconds $(if ($didWork) { 5 } else { 30 })
    }
    catch {
        Write-Log "Loop error: $($_.Exception.Message)"
        Start-Sleep -Seconds 5
    }
}
