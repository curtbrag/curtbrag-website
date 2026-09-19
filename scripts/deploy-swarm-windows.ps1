param(
    [string]$SshKey = "$env:USERPROFILE\.ssh\id_ed25519",
    [string]$SwarmUrl = "https://curtbrag.com/api/cluster",
    [int]$PollSeconds = 10
)

$ErrorActionPreference = "Stop"

$WorkerUrl = "https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/node-swarm.sh"
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

if (-not (Test-Path $SshKey)) {
    throw "SSH key missing: $SshKey"
}

$null = Get-Command ssh.exe -ErrorAction Stop
$null = Get-Command scp.exe -ErrorAction Stop

Write-Host ""
Write-Host "======================================================================"
Write-Host " CURT CLUSTER - SWARM V2 DEPLOY (WINDOWS)"
Write-Host "======================================================================"
Write-Host "Nodes     : 11"
Write-Host "Phones    : 8"
Write-Host "PCs       : Alina, Nexus, SteamDeck"
Write-Host "Mining    : UNCHANGED"
Write-Host "Reboots   : NONE"
Write-Host "API       : $SwarmUrl"
Write-Host "======================================================================"

Write-Host ""
Write-Host "[1] Downloading current node-swarm.sh..."
Invoke-WebRequest -Uri $WorkerUrl -OutFile $TempWorker -UseBasicParsing
if (-not (Test-Path $TempWorker)) {
    throw "Could not download node-swarm.sh"
}

$workerText = Get-Content $TempWorker -Raw
if ($workerText -notmatch 'AGENT_VERSION="2\.0\.0"') {
    throw "Downloaded worker is not Swarm v2.0.0. Stopping."
}
Write-Host "    SWARM_WORKER=2.0.0"

$sshBase = @(
    '-n',
    '-i', $SshKey,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=6'
)

function Invoke-NodeSsh {
    param(
        [pscustomobject]$Node,
        [string]$Command
    )

    $args = @($sshBase)
    $args += @('-p', [string]$Node.Port, "$($Node.User)@$($Node.IP)", $Command)
    $out = @(& ssh.exe @args 2>&1)
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = ($out -join "`n")
    }
}

function Copy-NodeFile {
    param([pscustomobject]$Node)

    $args = @(
        '-q',
        '-P', [string]$Node.Port,
        '-i', $SshKey,
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=NUL',
        '-o', 'LogLevel=ERROR',
        '-o', 'ConnectTimeout=6',
        $TempWorker,
        "$($Node.User)@$($Node.IP):node-swarm.sh"
    )

    & scp.exe @args 2>$null
    return ($LASTEXITCODE -eq 0)
}

# Exact process scan: kills only sh instances whose argv contains the exact
# $HOME/node-swarm.sh path as its own argument. No pgrep -f self-match games.
$stopScript = @'
SCRIPT="$HOME/node-swarm.sh"
for D in /proc/[0-9]*; do
  [ -r "$D/cmdline" ] || continue
  HIT=0
  while IFS= read -r ARG; do
    [ "$ARG" = "$SCRIPT" ] && HIT=1
  done <<EOF
$(tr '\0' '\n' < "$D/cmdline" 2>/dev/null)
EOF
  if [ "$HIT" = 1 ]; then
    P="${D##*/}"
    [ "$P" = "$$" ] || kill "$P" 2>/dev/null || true
  fi
done
sleep 1
true
'@

$verifyScript = @'
STATE="$HOME/cluster/state/node-swarm.pid"
P="$(cat "$STATE" 2>/dev/null || true)"
case "$P" in
  ''|*[!0-9]*) exit 1 ;;
esac
[ -r "/proc/$P/cmdline" ] || exit 1
FOUND=0
while IFS= read -r ARG; do
  [ "$ARG" = "$HOME/node-swarm.sh" ] && FOUND=1
done <<EOF
$(tr '\0' '\n' < "/proc/$P/cmdline" 2>/dev/null)
EOF
[ "$FOUND" = 1 ] || exit 1
printf 'SWARM_PID=%s' "$P"
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
        $results += [pscustomobject]@{ Name=$node.Name; SSH=$false; Copy=$false; Parse=$false; Running=$false; PID='' }
        continue
    }
    Write-Host "    SSH=PASS"

    if (-not (Copy-NodeFile $node)) {
        Write-Host "    COPY=FAIL" -ForegroundColor Red
        $results += [pscustomobject]@{ Name=$node.Name; SSH=$true; Copy=$false; Parse=$false; Running=$false; PID='' }
        continue
    }
    Write-Host "    COPY=PASS"

    $parse = Invoke-NodeSsh $node 'sh -n "$HOME/node-swarm.sh" && printf PARSE_OK'
    if ($parse.ExitCode -ne 0 -or $parse.Output -notmatch 'PARSE_OK') {
        Write-Host "    PARSE=FAIL" -ForegroundColor Red
        $results += [pscustomobject]@{ Name=$node.Name; SSH=$true; Copy=$true; Parse=$false; Running=$false; PID='' }
        continue
    }
    Write-Host "    PARSE=PASS"

    $null = Invoke-NodeSsh $node $stopScript

    $launch = "mkdir -p `"`$HOME/cluster/logs`" `"`$HOME/cluster/state`"; DEVICE_ID='$($node.Name)' NODE_CLASS='$($node.Class)' SWARM_URL='$SwarmUrl' POLL_INTERVAL='$PollSeconds' nohup sh `"`$HOME/node-swarm.sh`" >> `"`$HOME/cluster/logs/swarm-agent.log`" 2>&1 </dev/null &"
    $null = Invoke-NodeSsh $node $launch

    Start-Sleep -Seconds 2

    $verify = Invoke-NodeSsh $node $verifyScript
    $running = ($verify.ExitCode -eq 0 -and $verify.Output -match 'SWARM_PID=(\d+)')
    $remoteProcId = if ($running) { $Matches[1] } else { '' }

    if ($running) {
        Write-Host "    SWARM=RUNNING PID=$remoteProcId" -ForegroundColor Green
    }
    else {
        Write-Host "    SWARM=FAIL" -ForegroundColor Red
        $tail = Invoke-NodeSsh $node 'tail -n 10 "$HOME/cluster/logs/swarm-agent.log" 2>/dev/null || true'
        if ($tail.Output) { Write-Host $tail.Output }
    }

    $results += [pscustomobject]@{
        Name    = $node.Name
        SSH     = $true
        Copy    = $true
        Parse   = $true
        Running = $running
        PID     = $remoteProcId
    }
}

Write-Host ""
Write-Host "[3] Waiting for heartbeats..."
Start-Sleep -Seconds 12

$status = $null
try {
    $status = Invoke-RestMethod -Uri "$SwarmUrl?action=queue-status" -Method Get -TimeoutSec 20
}
catch {
    Write-Host "    API_STATUS=FAILED: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "======================================================================"
Write-Host " SWARM V2 DEPLOY RESULT"
Write-Host "======================================================================"
$results | Format-Table Name,SSH,Copy,Parse,Running,PID -AutoSize

$runningCount = @($results | Where-Object { $_.Running }).Count
Write-Host ""
Write-Host "Agents running    : $runningCount / 11"

if ($status) {
    Write-Host "API schema        : $($status.schema)"
    Write-Host "Swarm nodes online: $($status.nodes_online)"
    Write-Host "Queued jobs       : $($status.queued)"
    Write-Host "Pending assigns   : $($status.assignments_pending)"
    Write-Host ""
    if ($status.nodes) {
        $status.nodes |
            Select-Object id,online,busy,node_class,agent_version,last_seen |
            Sort-Object id |
            Format-Table -AutoSize
    }
}

Write-Host "Mining changed    : NO"
Write-Host "Reboots           : NONE"
Write-Host "======================================================================"
