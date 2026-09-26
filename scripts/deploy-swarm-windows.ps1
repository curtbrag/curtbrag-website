param(
    [string]$SshKey = "$env:USERPROFILE\.ssh\id_ed25519",
    [string]$SwarmUrl = "https://curtbrag.com/api/cluster",
    [string]$WorkerUrl = "https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/node-swarm.sh",
    [string]$ConfigPath = "$env:LOCALAPPDATA\CurtCluster\bridge-config.json",
    [int]$PollSeconds = 60,
    [ValidateSet('all','phones','pcs')]
    [string]$TargetGroup = 'all',
    [switch]$EnablePhoneBoot
)

$ErrorActionPreference = "Stop"

$TempWorker = Join-Path $env:TEMP "curt-node-swarm.sh"

$Nodes = @(
    [pscustomobject]@{ Name="phone173"; IP="192.168.1.173"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="phone174"; IP="192.168.1.174"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="phone176"; IP="192.168.1.176"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="phone177"; IP="192.168.1.177"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="phone191"; IP="192.168.1.191"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="phone195"; IP="192.168.1.195"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="phone253"; IP="192.168.1.253"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="phone254"; IP="192.168.1.254"; User="u0_a191"; Port=8022; Class="worker" }
    [pscustomobject]@{ Name="Alina"; IP="192.168.1.193"; User="neo"; Port=22; Class="pc" }
    [pscustomobject]@{ Name="Nexus"; IP="192.168.1.192"; User="neo"; Port=22; Class="pc" }
    [pscustomobject]@{ Name="SteamDeck"; IP="192.168.1.166"; User="deck"; Port=22; Class="pc" }
)
if ($TargetGroup -eq 'phones') { $Nodes = @($Nodes | Where-Object { $_.Name -like 'phone*' }) }
if ($TargetGroup -eq 'pcs') { $Nodes = @($Nodes | Where-Object { $_.Name -notlike 'phone*' }) }

if (-not (Test-Path $SshKey)) { throw "SSH key missing: $SshKey" }
$null = Get-Command ssh.exe -ErrorAction Stop
$null = Get-Command scp.exe -ErrorAction Stop

$WebPassword = $null
if (Test-Path $ConfigPath) {
    try {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($cfg.password_cipher) {
            $secure = ConvertTo-SecureString $cfg.password_cipher
            $WebPassword = [System.Net.NetworkCredential]::new('', $secure).Password
        }
    }
    catch { $WebPassword = $null }
}

Write-Host ""
Write-Host "======================================================================"
Write-Host " CURT CLUSTER - SWARM V2.2.0 DEPLOY (WINDOWS)"
Write-Host "======================================================================"
$phoneCount = @($Nodes | Where-Object { $_.Name -like 'phone*' }).Count
$pcNames = @($Nodes | Where-Object { $_.Name -notlike 'phone*' } | ForEach-Object { $_.Name }) -join ', '
Write-Host "Nodes     : $($Nodes.Count)"
Write-Host "Phones    : $phoneCount"
Write-Host "PCs       : $pcNames"
Write-Host "Boot      : $(if ($EnablePhoneBoot) { 'TERMUX BOOT SCRIPT' } else { 'UNCHANGED' })"
Write-Host "Mining    : UNCHANGED"
Write-Host "Reboots   : NONE"
Write-Host "API       : $SwarmUrl"
Write-Host "======================================================================"

Write-Host ""
Write-Host "[1] Downloading current node-swarm.sh..."
Invoke-WebRequest -Uri $WorkerUrl -OutFile $TempWorker -UseBasicParsing
if (-not (Test-Path $TempWorker)) { throw "Could not download node-swarm.sh" }

$workerText = Get-Content $TempWorker -Raw
if ($workerText -notmatch 'AGENT_VERSION="2\.2\.0"') {
    throw "Downloaded worker is not Swarm v2.2.0. Stopping."
}
if ($workerText -notmatch 'mining-stop\|miner-stop' -or $workerText -notmatch 'mining-start\|miner-start') {
    throw "Downloaded worker is missing miner controls."
}
if ($workerText -notmatch 'prune_other_swarm_agents') {
    throw "Downloaded worker is missing singleton ownership protection."
}
Write-Host "    SWARM_WORKER=2.2.0"
Write-Host "    MINER_COMMANDS=PASS"
Write-Host "    SINGLETON_GUARD=PASS"

$sshBase = @(
    '-n', '-i', $SshKey,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=6'
)

function Invoke-NodeSsh {
    param([pscustomobject]$Node, [string]$Command)
    $sshArgs = @($sshBase)
    $sshArgs += @('-p', [string]$Node.Port, "$($Node.User)@$($Node.IP)", $Command)
    $out = @(& ssh.exe @sshArgs 2>&1)
    [pscustomobject]@{ ExitCode=$LASTEXITCODE; Output=($out -join "`n") }
}

function Copy-NodeFile {
    param([pscustomobject]$Node)
    $scpArgs = @(
        '-q', '-P', [string]$Node.Port, '-i', $SshKey,
        '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL',
        '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=6',
        $TempWorker, "$($Node.User)@$($Node.IP):node-swarm.sh"
    )
    & scp.exe @scpArgs 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Install-PhoneBoot([pscustomobject]$Node) {
    # The values are inserted into single-quoted POSIX shell strings below.
    $quotedUrl = $SwarmUrl.Replace("'", "'\''")
    $boot = @'
#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
mkdir -p "$HOME/cluster/logs" "$HOME/cluster/state"
if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock >/dev/null 2>&1 || true; fi
sshd >/dev/null 2>&1 || true
if [ -f "$HOME/node-swarm.sh" ]; then
  DEVICE_ID='__DEVICE__' NODE_CLASS='worker' SWARM_URL='__URL__' POLL_INTERVAL='__POLL__' nohup sh "$HOME/node-swarm.sh" >> "$HOME/cluster/logs/swarm-agent.log" 2>&1 </dev/null &
fi
'@
    $boot = $boot.Replace('__DEVICE__', $Node.Name).Replace('__URL__', $quotedUrl).Replace('__POLL__', "$PollSeconds")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($boot))
    $remote = 'mkdir -p "$HOME/.termux/boot" && printf %s ' + $encoded + ' | base64 -d > "$HOME/.termux/boot/10-curt-swarm.tmp" && sh -n "$HOME/.termux/boot/10-curt-swarm.tmp" && chmod 700 "$HOME/.termux/boot/10-curt-swarm.tmp" && mv "$HOME/.termux/boot/10-curt-swarm.tmp" "$HOME/.termux/boot/10-curt-swarm" && printf BOOT_READY'
    $installed = Invoke-NodeSsh $Node $remote
    if ($installed.ExitCode -ne 0 -or $installed.Output -notmatch 'BOOT_READY') { return $false }
    $null = Invoke-NodeSsh $Node 'command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock >/dev/null 2>&1 || true'
    return $true
}

$stopScript = @'
SCRIPT="$HOME/node-swarm.sh"
kill_swarm() {
  SIG="$1"
  for D in /proc/[0-9]*; do
    [ -r "$D/cmdline" ] || continue
    P="${D##*/}"
    HIT=0
    while IFS= read -r ARG; do
      [ "$ARG" = "$SCRIPT" ] && HIT=1
    done <<EOF
$(tr '\0' '\n' < "$D/cmdline" 2>/dev/null)
EOF
    if [ "$HIT" = 1 ] && [ "$P" != "$$" ]; then
      if [ "$SIG" = KILL ]; then kill -9 "$P" 2>/dev/null || true; else kill "$P" 2>/dev/null || true; fi
    fi
  done
}
kill_swarm TERM
sleep 1
kill_swarm KILL
sleep 1
true
'@

$verifyScript = @'
STATE="$HOME/cluster/state/node-swarm.pid"
P="$(cat "$STATE" 2>/dev/null || true)"
case "$P" in ''|*[!0-9]*) exit 1 ;; esac
[ -r "/proc/$P/cmdline" ] || exit 1
SCRIPT="$HOME/node-swarm.sh"
COUNT=0
OWNER=0
for D in /proc/[0-9]*; do
  [ -r "$D/cmdline" ] || continue
  Q="${D##*/}"
  HIT=0
  while IFS= read -r ARG; do
    [ "$ARG" = "$SCRIPT" ] && HIT=1
  done <<EOF
$(tr '\0' '\n' < "$D/cmdline" 2>/dev/null)
EOF
  if [ "$HIT" = 1 ]; then
    COUNT=$((COUNT + 1))
    [ "$Q" = "$P" ] && OWNER=1
  fi
done
[ "$OWNER" = 1 ] || exit 1
[ "$COUNT" -eq 1 ] || { printf 'DUPLICATE_COUNT=%s' "$COUNT"; exit 2; }
printf 'SWARM_PID=%s SINGLETON=1' "$P"
'@

Write-Host ""
Write-Host "[2] Deploying agent..."
$results = @()

foreach ($node in $Nodes) {
    Write-Host ""
    Write-Host ("---- {0}  {1}  {2}@:{3} ----" -f $node.Name, $node.IP, $node.User, $node.Port)

    $probe = Invoke-NodeSsh $node 'printf CONNECT_OK'
    if ($probe.ExitCode -ne 0 -or $probe.Output -notmatch 'CONNECT_OK') {
        Write-Host "    SSH=FAIL" -ForegroundColor Red
        $results += [pscustomobject]@{ Name=$node.Name; SSH=$false; Copy=$false; Parse=$false; Running=$false; Singleton=$false; PID=''; Mode='' }
        continue
    }
    Write-Host "    SSH=PASS"

    if (-not (Copy-NodeFile $node)) {
        Write-Host "    COPY=FAIL" -ForegroundColor Red
        $results += [pscustomobject]@{ Name=$node.Name; SSH=$true; Copy=$false; Parse=$false; Running=$false; Singleton=$false; PID=''; Mode='' }
        continue
    }
    Write-Host "    COPY=PASS"

    $parse = Invoke-NodeSsh $node 'chmod 700 "$HOME/node-swarm.sh"; sh -n "$HOME/node-swarm.sh" && printf PARSE_OK'
    if ($parse.ExitCode -ne 0 -or $parse.Output -notmatch 'PARSE_OK') {
        Write-Host "    PARSE=FAIL" -ForegroundColor Red
        $results += [pscustomobject]@{ Name=$node.Name; SSH=$true; Copy=$true; Parse=$false; Running=$false; Singleton=$false; PID=''; Mode='' }
        continue
    }
    Write-Host "    PARSE=PASS"

    $serviceProbe = Invoke-NodeSsh $node 'systemctl --user cat curt-swarm.service >/dev/null 2>&1 && printf SYSTEMD || true'
    $mode = 'nohup'

    if ($serviceProbe.Output -match 'SYSTEMD') {
        $null = Invoke-NodeSsh $node $stopScript
        $restart = Invoke-NodeSsh $node 'systemctl --user daemon-reload >/dev/null 2>&1 || true; systemctl --user restart curt-swarm.service; sleep 3; systemctl --user is-active curt-swarm.service'
        if ($restart.ExitCode -eq 0 -and $restart.Output -match 'active') {
            $mode = 'systemd'
        }
        else {
            Write-Host "    SYSTEMD_RESTART=FAIL; falling back to nohup" -ForegroundColor Yellow
            $null = Invoke-NodeSsh $node 'systemctl --user stop curt-swarm.service >/dev/null 2>&1 || true'
        }
    }

    if ($mode -eq 'nohup') {
        $null = Invoke-NodeSsh $node $stopScript
        $launch = "mkdir -p `$HOME/cluster/logs `$HOME/cluster/state; DEVICE_ID='$($node.Name)' NODE_CLASS='$($node.Class)' SWARM_URL='$SwarmUrl' POLL_INTERVAL='$PollSeconds' nohup sh `$HOME/node-swarm.sh >> `$HOME/cluster/logs/swarm-agent.log 2>&1 </dev/null &"
        $null = Invoke-NodeSsh $node $launch
    }

    Start-Sleep -Seconds 3
    $verify = Invoke-NodeSsh $node $verifyScript
    $pidMatch = [regex]::Match($verify.Output, 'SWARM_PID=(\d+)')
    $running = ($verify.ExitCode -eq 0 -and $pidMatch.Success)
    $singleton = ($verify.ExitCode -eq 0 -and $verify.Output -match 'SINGLETON=1')
    $remoteProcId = if ($running) { $pidMatch.Groups[1].Value } else { '' }

    if ($running -and $singleton) {
        Write-Host "    SWARM=RUNNING PID=$remoteProcId MODE=$mode SINGLETON=PASS" -ForegroundColor Green
    }
    else {
        Write-Host "    SWARM=FAIL VERIFY=$($verify.Output)" -ForegroundColor Red
        $tail = Invoke-NodeSsh $node 'tail -n 14 "$HOME/cluster/logs/swarm-agent.log" 2>/dev/null || true'
        if ($tail.Output) { Write-Host $tail.Output }
    }

    if ($running -and $EnablePhoneBoot -and $node.Name -like 'phone*') {
        if (Install-PhoneBoot $node) { Write-Host '    BOOT=SCRIPT_READY (Termux:Boot app required)' -ForegroundColor Green }
        else { Write-Host '    BOOT=FAIL (agent remains running)' -ForegroundColor Yellow }
    }

    $results += [pscustomobject]@{
        Name=$node.Name; SSH=$true; Copy=$true; Parse=$true; Running=$running; Singleton=$singleton; PID=$remoteProcId; Mode=$mode
    }
}

Write-Host ""
Write-Host "[3] Waiting for heartbeats..."
Start-Sleep -Seconds 12

$status = $null
if ($WebPassword) {
    try {
        $status = Invoke-RestMethod `
            -Uri "${SwarmUrl}?action=queue-status" `
            -Method Get `
            -Headers @{ Authorization = "Bearer $WebPassword" } `
            -TimeoutSec 20
    }
    catch {
        Write-Host "    API_STATUS=FAILED: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}
else {
    Write-Host "    API_STATUS=SKIPPED (dashboard password not available locally)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "======================================================================"
Write-Host " SWARM V2.2.0 DEPLOY RESULT"
Write-Host "======================================================================"
$results | Format-Table Name,SSH,Copy,Parse,Running,Singleton,PID,Mode -AutoSize

$runningCount = @($results | Where-Object { $_.Running -and $_.Singleton }).Count
Write-Host ""
Write-Host "Singleton agents   : $runningCount / $($Nodes.Count)"

if ($status) {
    Write-Host "API schema         : $($status.schema)"
    Write-Host "Swarm nodes online : $($status.nodes_online)"
    Write-Host "Queued jobs        : $($status.queued)"
    Write-Host "Pending assigns    : $($status.assignments_pending)"
    Write-Host "Operator auth      : $($status.auth_enforced)"
    Write-Host "Worker auth        : $($status.worker_auth_enforced)"
    Write-Host ""
    if ($status.nodes) {
        $status.nodes |
            Select-Object id,online,busy,node_class,agent_version,agent_pid,last_seen |
            Sort-Object id |
            Format-Table -AutoSize
    }
}

Write-Host "Mining changed     : NO"
Write-Host "Reboots            : NONE"
Write-Host "======================================================================"
