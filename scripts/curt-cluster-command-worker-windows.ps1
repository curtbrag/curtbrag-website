param(
    [string]$ConfigPath = "$env:LOCALAPPDATA\CurtCluster\bridge-config.json"
)

$ErrorActionPreference = 'Stop'

$base = Join-Path $env:LOCALAPPDATA 'CurtCluster'
$logPath = Join-Path $base 'command-worker.log'
New-Item -ItemType Directory -Force -Path $base | Out-Null

function Write-Log([string]$Message) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    try { Add-Content -Path $logPath -Value $line -ErrorAction SilentlyContinue } catch {}
}

if (-not (Test-Path $ConfigPath)) {
    Write-Log "Missing config: $ConfigPath"
    exit 2
}

try {
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $secure = ConvertTo-SecureString $cfg.password_cipher
    $password = [System.Net.NetworkCredential]::new('', $secure).Password
}
catch {
    Write-Log "Config/decrypt error: $($_.Exception.Message)"
    exit 2
}

$api = if ($cfg.api_url) { [string]$cfg.api_url } else { 'https://curtbrag.com/.netlify/functions/cluster-api' }
$key = if ($cfg.ssh_key) { [string]$cfg.ssh_key } else { "$env:USERPROFILE\.ssh\id_ed25519" }
$phoneUser = if ($cfg.phone_user) { [string]$cfg.phone_user } else { 'user' }
$phonePort = if ($cfg.phone_port) { [int]$cfg.phone_port } else { 8022 }
$poolHost = if ($cfg.pool_host) { [string]$cfg.pool_host } else { 'gulf.moneroocean.stream' }
$poolPort = if ($cfg.pool_port) { [int]$cfg.pool_port } else { 10128 }
$wallet = [string]$cfg.wallet
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source

if (-not (Test-Path $key)) { throw "SSH key missing: $key" }
if ($poolHost -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid pool host' }
if ($wallet -notmatch '^[A-Za-z0-9]+$') { throw 'Invalid wallet' }

$headers = @{ Authorization = "Bearer $password"; 'Content-Type' = 'application/json' }
$phones = @(
    [pscustomobject]@{ Hostname='phone173'; IP='192.168.1.173' },
    [pscustomobject]@{ Hostname='phone174'; IP='192.168.1.174' },
    [pscustomobject]@{ Hostname='phone176'; IP='192.168.1.176' },
    [pscustomobject]@{ Hostname='phone177'; IP='192.168.1.177' },
    [pscustomobject]@{ Hostname='phone191'; IP='192.168.1.191' },
    [pscustomobject]@{ Hostname='phone195'; IP='192.168.1.195' },
    [pscustomobject]@{ Hostname='phone253'; IP='192.168.1.253' },
    [pscustomobject]@{ Hostname='phone254'; IP='192.168.1.254' }
)

function Get-ApiUri([string]$Action) {
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    "$($api)?action=$([uri]::EscapeDataString($Action))&_=$stamp"
}

function ApiGet([string]$Action) {
    Invoke-RestMethod -Uri (Get-ApiUri $Action) -Headers $headers -Method Get -TimeoutSec 20
}

function ApiPost([string]$Action, $Body) {
    $json = $Body | ConvertTo-Json -Depth 12 -Compress
    Invoke-RestMethod -Uri (Get-ApiUri $Action) -Headers $headers -Method Post -Body $json -TimeoutSec 20
}

function Invoke-Phone([string]$IP, [string]$Remote) {
    $args = @(
        '-n','-p',"$phonePort",'-i',$key,
        '-o','BatchMode=yes','-o','IdentitiesOnly=yes',
        '-o','ConnectTimeout=7','-o','ConnectionAttempts=1',
        '-o','ServerAliveInterval=2','-o','ServerAliveCountMax=2',
        '-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL',
        '-o','LogLevel=ERROR',
        "$phoneUser@$IP",$Remote
    )
    $out = @(& $ssh @args 2>&1 | ForEach-Object { "$_" })
    [pscustomobject]@{ Exit=$LASTEXITCODE; Output=$out }
}

function Get-Devices {
    @((ApiGet 'devices').devices)
}

function Resolve-Targets([string]$Target) {
    if (-not $Target -or $Target -in @('all','phones')) { return @($phones) }
    if ($Target -match '^phone\d+$') { return @($phones | Where-Object Hostname -eq $Target) }

    $devices = Get-Devices
    $d = $devices | Where-Object { $_.id -eq $Target -or $_.hostname -eq $Target } | Select-Object -First 1
    if ($d -and $d.hostname -like 'phone*') {
        return @($phones | Where-Object Hostname -eq $d.hostname)
    }
    return @()
}

$stateCommand = @'
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
XPID="$(pgrep -x xmrig 2>/dev/null | head -1)"
echo "XMRIG_PID=$XPID"
if [ -n "$XPID" ]; then echo RUNNING=true; else echo RUNNING=false; fi
if [ -x "$HOME/bin/xmrig" ]; then
  echo BIN=READY
  echo "BINHASH=$(sha256sum "$HOME/bin/xmrig" 2>/dev/null | awk '{print $1}')"
else
  echo BIN=MISSING
  echo BINHASH=
fi
HR=0
if [ -n "$XPID" ] && [ -f "$HOME/xmrig.log" ]; then
  HR="$(grep 'miner    speed' "$HOME/xmrig.log" 2>/dev/null | tail -1 | awk '{for(i=1;i<=NF;i++) if($i ~ /^10s\/60s\/15m$/){v=$(i+2); if(v ~ /^[0-9.]+$/) print v; else print 0; exit}}')"
fi
echo "HASHRATE=${HR:-0}"
'@

function Get-PhoneState($Phone) {
    $r = Invoke-Phone $Phone.IP $stateCommand
    if ($r.Exit -ne 0) { return $null }
    $joined = $r.Output -join "`n"
    $running = $joined -match '(?m)^RUNNING=true$'
    [int]$procId = 0
    if ($joined -match '(?m)^XMRIG_PID=(\d+)$') { $procId = [int]$Matches[1] }
    [double]$rate = 0
    if ($running -and $joined -match '(?m)^HASHRATE=([0-9.]+)$') {
        [void][double]::TryParse($Matches[1],[ref]$rate)
    }
    if (-not $running) { $procId = 0; $rate = 0 }
    $hash = ''
    if ($joined -match '(?m)^BINHASH=([a-fA-F0-9]{64})$') { $hash = $Matches[1].ToLower() }
    [pscustomobject]@{ Running=$running; ProcId=$procId; Hashrate=$rate; Hash=$hash; Raw=$joined }
}

function Push-State($Phone,$State) {
    if (-not $State) { return }
    ApiPost 'bridge-touch-device' @{
        hostname=$Phone.Hostname
        observed=@{
            xmrig_running=$State.Running
            hashrate_60s=$State.Hashrate
            custom_pid=$State.ProcId
            binary_hash=$State.Hash
            agent_version='windows-command-worker-1.0'
            workload_type='mining'
            workload_enabled=$State.Running
            preflight_status='ok'
        }
    } | Out-Null
}

function Get-Device([string]$Hostname) {
    Get-Devices | Where-Object hostname -eq $Hostname | Select-Object -First 1
}

function Start-Phone($Phone,[bool]$Force=$false) {
    $device = Get-Device $Phone.Hostname
    if (-not $device) { return [pscustomobject]@{ Exit=2; Output=@('DEVICE_NOT_REGISTERED') } }

    $ph = if ($device.desired.pool_url -and $device.desired.pool_url -ne '192.168.1.179') { [string]$device.desired.pool_url } else { $poolHost }
    if ($ph -notmatch '^[A-Za-z0-9._-]+$') { $ph = $poolHost }
    $pp = if ($device.desired.pool_port) { [int]$device.desired.pool_port } else { $poolPort }
    if ($pp -lt 1 -or $pp -gt 65535) { $pp = $poolPort }
    $threads = if ($device.desired.thread_count) { [int]$device.desired.thread_count } else { 6 }
    if ($threads -lt 1 -or $threads -gt 16) { $threads = 6 }
    $rx = if ($device.desired.randomx_mode) { [string]$device.desired.randomx_mode } else { 'light' }
    if ($rx -notin @('light','fast','auto')) { $rx='light' }
    $approved = if ($device.desired.approved_binary_hash -match '^[a-fA-F0-9]{64}$') { [string]$device.desired.approved_binary_hash } else { '' }
    $workerName = "$wallet.$($Phone.Hostname)"
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

    $remote = $template.Replace('__POOL__',$endpoint).Replace('__WORKER__',$workerName).Replace('__THREADS__',"$threads").Replace('__RXMODE__',$rx).Replace('__APPROVED__',$approved).Replace('__FORCE__',$forceText)
    Invoke-Phone $Phone.IP $remote
}

function Stop-Phone($Phone) {
    $remote = @'
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
pkill -9 xmrig 2>/dev/null || true
sleep 1
pgrep -x xmrig >/dev/null 2>&1 && echo STILL_RUNNING || echo STOPPED
'@
    Invoke-Phone $Phone.IP $remote
}

function Diagnose-Phone($Phone) {
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
tail -25 "$HOME/xmrig.log" 2>/dev/null || true
'@
    Invoke-Phone $Phone.IP $remote
}

function Complete-Command($Command,[string]$Output) {
    ApiPost 'bridge-complete' @{
        id=$Command.id
        target=$Command.target
        type=$Command.type
        result_summary="completed $($Command.type) -> $($Command.target)"
        output=$Output
    } | Out-Null
}

function Process-OneCommand {
    $response = ApiGet 'commands'
    if (-not $response -or @($response.queue).Count -eq 0) { return $false }

    $cmd = @($response.queue)[0]
    Write-Log "Processing $($cmd.id) type=$($cmd.type) target=$($cmd.target)"
    $targets = @(Resolve-Targets ([string]$cmd.target))
    $output = New-Object System.Collections.Generic.List[string]

    if ($targets.Count -eq 0) {
        $output.Add("TARGET_UNAVAILABLE: $($cmd.target)")
        Complete-Command $cmd ($output -join "`n")
        return $true
    }

    foreach ($phone in $targets) {
        $output.Add("===== $($phone.Hostname) / $($cmd.type) =====")
        $actionResult = $null
        switch ([string]$cmd.type) {
            { $_ -in @('mining-start','fresh-connect','start') } { $actionResult = Start-Phone $phone $false; break }
            'restart' { $actionResult = Start-Phone $phone $true; break }
            { $_ -in @('mining-stop','stop','kill-rogue') } { $actionResult = Stop-Phone $phone; break }
            { $_ -in @('mining-status','verify-all','status','fetch-logs') } {
                $state = Get-PhoneState $phone
                if ($state) { Push-State $phone $state; $actionResult=[pscustomobject]@{Exit=0;Output=@($state.Raw)} }
                else { $actionResult=[pscustomobject]@{Exit=1;Output=@('UNREACHABLE')} }
                break
            }
            'run-diagnostic' { $actionResult = Diagnose-Phone $phone; break }
            'reconcile' {
                $device = Get-Device $phone.Hostname
                $enabled = ($device -and -not $device.quarantined -and [bool]$device.desired.miner_enabled)
                if ($enabled) { $actionResult = Start-Phone $phone $true } else { $actionResult = Stop-Phone $phone }
                break
            }
            'reset-restart-count' { $actionResult=[pscustomobject]@{Exit=0;Output=@('RESET_OK')}; break }
            'reboot' { $actionResult=[pscustomobject]@{Exit=0;Output=@('REBOOT_SKIPPED_SAFETY')}; break }
            default { $actionResult=[pscustomobject]@{Exit=2;Output=@("UNSUPPORTED_COMMAND: $($cmd.type)")} }
        }

        foreach ($line in @($actionResult.Output)) { $output.Add("$line") }
        if ($cmd.type -notin @('mining-status','verify-all','status','fetch-logs')) {
            $state = Get-PhoneState $phone
            if ($state) { Push-State $phone $state }
        }
    }

    Complete-Command $cmd ($output -join "`n")
    Write-Log "Completed $($cmd.id)"
    return $true
}

Write-Log 'Curt cluster command worker started.'
while ($true) {
    try {
        $worked = Process-OneCommand
        if ($worked) { Start-Sleep -Milliseconds 500 } else { Start-Sleep -Seconds 2 }
    }
    catch {
        Write-Log "Loop error: $($_.Exception.Message)"
        Start-Sleep -Seconds 3
    }
}
