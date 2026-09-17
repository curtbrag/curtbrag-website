param(
    [string]$ConfigPath = "$env:LOCALAPPDATA\CurtCluster\bridge-config.json"
)

$ErrorActionPreference = 'Continue'

function Write-Log([string]$Message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$stamp] $Message"
    Write-Host $line
    try { Add-Content -Path "$env:LOCALAPPDATA\CurtCluster\bridge.log" -Value $line -ErrorAction SilentlyContinue } catch {}
}

if (-not (Test-Path $ConfigPath)) {
    Write-Log "Missing config: $ConfigPath"
    exit 2
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
try {
    $secure = ConvertTo-SecureString $config.password_cipher
    $password = [System.Net.NetworkCredential]::new('', $secure).Password
} catch {
    Write-Log "Cannot decrypt dashboard password under this Windows account."
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

if (-not $ssh -or -not (Test-Path $key)) {
    Write-Log "SSH client/key missing. ssh=$ssh key=$key"
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

$headers = @{ Authorization = "Bearer $password"; 'Content-Type'='application/json' }

function Invoke-ApiGet([string]$Action) {
    try { return Invoke-RestMethod -Uri "$api?action=$Action&_=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers $headers -Method Get -TimeoutSec 20 }
    catch { Write-Log "API GET $Action failed: $($_.Exception.Message)"; return $null }
}

function Invoke-ApiPost([string]$Action, $Body) {
    try {
        $json = $Body | ConvertTo-Json -Depth 12 -Compress
        return Invoke-RestMethod -Uri "$api?action=$Action" -Headers $headers -Method Post -Body $json -TimeoutSec 20
    } catch { Write-Log "API POST $Action failed: $($_.Exception.Message)"; return $null }
}

function Invoke-Phone([string]$IP, [string]$Remote, [int]$Timeout=20) {
    $args = @('-n','-p',"$phonePort",'-i',$key,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=5','-o','ConnectionAttempts=1','-o','ServerAliveInterval=2','-o','ServerAliveCountMax=2','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL','-o','LogLevel=ERROR',"$phoneUser@$IP",$Remote)
    $job = Start-Job -ScriptBlock { param($exe,$argv) & $exe @argv 2>&1; [pscustomobject]@{ Exit=$LASTEXITCODE } } -ArgumentList $ssh,(,$args)
    if (-not (Wait-Job $job -Timeout $Timeout)) { Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue; return [pscustomobject]@{ Exit=124; Output=@('TIMEOUT') } }
    $all = @(Receive-Job $job)
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    $meta = $all | Where-Object { $_ -is [pscustomobject] -and $_.PSObject.Properties.Name -contains 'Exit' } | Select-Object -Last 1
    $text = @($all | Where-Object { -not ($_ -is [pscustomobject] -and $_.PSObject.Properties.Name -contains 'Exit') } | ForEach-Object { "$_" })
    [pscustomobject]@{ Exit = if ($meta) { [int]$meta.Exit } else { 1 }; Output=$text }
}

function Get-Devices { $r = Invoke-ApiGet 'devices'; if ($r -and $r.devices) { return @($r.devices) }; @() }

function Ensure-Device([string]$Hostname,[string]$IP,[string]$Class='phone',[string]$Role='worker') {
    $devices = @(Get-Devices)
    $d = $devices | Where-Object hostname -eq $Hostname | Select-Object -First 1
    if ($d -and $d.current_ip -and $d.current_ip -ne $IP) {
        Invoke-ApiPost 'delete-device' @{ device_id=$d.id } | Out-Null
        $d = $null
    }
    if (-not $d) {
        Invoke-ApiPost 'create-device' @{ hostname=$Hostname; ip=$IP; device_class=$Class; cluster_role=$Role } | Out-Null
    }
}

function Reconcile-Registry {
    Write-Log 'Reconciling dashboard registry to current hardware.'
    $devices = @(Get-Devices)
    $old = $devices | Where-Object hostname -eq 'phone175' | Select-Object -First 1
    if ($old) { Invoke-ApiPost 'delete-device' @{ device_id=$old.id } | Out-Null }
    foreach ($p in $phones) { Ensure-Device $p.Hostname $p.IP }
    Ensure-Device 'nexus' '192.168.1.192' 'pc' 'control-plane'

    $devices = @(Get-Devices)
    foreach ($p in $phones) {
        $d = $devices | Where-Object hostname -eq $p.Hostname | Select-Object -First 1
        if ($d -and (($d.desired.pool_url -eq '192.168.1.179') -or -not $d.desired.pool_url)) {
            Invoke-ApiPost 'set-pool-config' @{ device_id=$d.id; pool_url=$poolHost; pool_port=$poolPort; thread_count=6; randomx_mode='light' } | Out-Null
        }
    }

    $devices = @(Get-Devices)
    $phoneIds = @($devices | Where-Object { $_.hostname -in $phones.Hostname } | ForEach-Object id)
    $nexusIds = @($devices | Where-Object hostname -eq 'nexus' | ForEach-Object id)
    Invoke-ApiPost 'save-group' @{ group_id='phones'; group_name='Phones'; description='Current eight OnePlus 6T workers'; device_ids=$phoneIds } | Out-Null
    Invoke-ApiPost 'save-group' @{ group_id='pcs'; group_name='Controllers'; description='Active Nexus controller'; device_ids=$nexusIds } | Out-Null
    Invoke-ApiPost 'save-group' @{ group_id='all'; group_name='Active Fleet'; description='Current live cluster'; device_ids=@($phoneIds + $nexusIds) } | Out-Null
}

$envPrefix = 'export HOME=/data/data/com.termux/files/home; export PREFIX=/data/data/com.termux/files/usr; export PATH="$PREFIX/bin:$HOME/bin:$PATH"; '

function Get-PhoneState($p) {
    $remote = $envPrefix + 'pid=$(pgrep -x xmrig 2>/dev/null | head -1); echo PID=$pid; if [ -n "$pid" ]; then echo RUNNING=true; else echo RUNNING=false; fi; hr=0; if [ -f "$HOME/xmrig.log" ]; then hr=$(grep "miner    speed" "$HOME/xmrig.log" 2>/dev/null | tail -1 | awk ''{for(i=1;i<=NF;i++) if($i ~ /^10s\/60s\/15m$/){v=$(i+2); if(v ~ /^[0-9.]+$/) print v; else print 0; exit}}''); fi; echo HASHRATE=${hr:-0}; if [ -x "$HOME/bin/xmrig" ]; then echo BINHASH=$(sha256sum "$HOME/bin/xmrig" 2>/dev/null | awk ''{print $1}''); fi'
    $r = Invoke-Phone $p.IP $remote 15
    if ($r.Exit -ne 0) { return $null }
    $joined = $r.Output -join "`n"
    $running = $joined -match '(?m)^RUNNING=true$'
    $hr = 0.0; if ($joined -match '(?m)^HASHRATE=([0-9.]+)$') { [double]::TryParse($Matches[1],[ref]$hr) | Out-Null }
    $pid = 0; if ($joined -match '(?m)^PID=(\d+)$') { $pid=[int]$Matches[1] }
    $hash=''; if ($joined -match '(?m)^BINHASH=([a-fA-F0-9]{64})$') { $hash=$Matches[1].ToLower() }
    [pscustomobject]@{ running=$running; hashrate=$hr; pid=$pid; hash=$hash; raw=$joined }
}

function Push-PhoneState($p) {
    $s = Get-PhoneState $p
    if (-not $s) { return $false }
    Invoke-ApiPost 'bridge-touch-device' @{ hostname=$p.Hostname; observed=@{ xmrig_running=$s.running; hashrate_60s=$s.hashrate; custom_pid=$s.pid; binary_hash=$s.hash; agent_version='windows-bridge-2.0'; workload_type='mining'; workload_enabled=$s.running; preflight_status='ok' } } | Out-Null
    return $true
}

function Get-DeviceForHost([string]$Hostname) { @(Get-Devices) | Where-Object hostname -eq $Hostname | Select-Object -First 1 }

function Start-Phone($p,[bool]$Force=$false) {
    $d = Get-DeviceForHost $p.Hostname
    $desired = $d.desired
    $ph = if ($desired.pool_url -and $desired.pool_url -ne '192.168.1.179') { [string]$desired.pool_url } else { $poolHost }
    $pp = if ($desired.pool_port) { [int]$desired.pool_port } else { $poolPort }
    $threads = if ($desired.thread_count) { [int]$desired.thread_count } else { 6 }
    if ($threads -lt 1 -or $threads -gt 16) { $threads=6 }
    $approved = if ($desired.approved_binary_hash) { [string]$desired.approved_binary_hash } else { '' }
    $worker = "$wallet.$($p.Hostname)"
    $forceNum = if ($Force) { 1 } else { 0 }
    $remote = $envPrefix + "BIN=\`$HOME/bin/xmrig; [ -x \"\`$BIN\" ] || { echo NO_BIN; exit 0; }; if [ -n '$approved' ]; then ACTUAL=\`$(sha256sum \"\`$BIN\" | awk '{print \`$1}'); [ \"\`$ACTUAL\" = '$approved' ] || { echo BLOCKED_BINARY_HASH_MISMATCH; exit 0; }; fi; OLD=\`$(pgrep -af xmrig 2>/dev/null | grep -v grep); if [ '$forceNum' != 1 ] && echo \"\`$OLD\" | grep -q '$worker' && echo \"\`$OLD\" | grep -q '$ph`:$pp'; then echo ALREADY_RUNNING_CORRECT; else pkill -9 xmrig 2>/dev/null || true; sleep 1; : > \`$HOME/xmrig.log; nohup \"\`$BIN\" -o '$ph`:$pp' -u '$worker' -p x -k --threads='$threads' --print-time=10 --log-file=\`$HOME/xmrig.log --no-color >/dev/null 2>&1 & sleep 4; fi; pgrep -af xmrig 2>/dev/null | grep -v grep || echo NO_PROCESS; tail -20 \`$HOME/xmrig.log 2>/dev/null | grep -E 'miner    speed|new job|accepted|error' | tail -5 || true"
    Invoke-Phone $p.IP $remote 20
}

function Stop-Phone($p) { Invoke-Phone $p.IP ($envPrefix + 'pkill -9 xmrig 2>/dev/null || true; sleep 1; pgrep -x xmrig >/dev/null && echo STILL_RUNNING || echo STOPPED') 10 }
function Diagnose-Phone($p) { Invoke-Phone $p.IP ($envPrefix + 'echo HOST=$(hostname); echo USER=$(whoami); echo UPTIME="$(uptime 2>/dev/null)"; echo XMRIG="$(pgrep -x xmrig 2>/dev/null | tr "\n" ",")"; echo SSHD=$(pgrep -x sshd | head -1); echo BIN=$(test -x "$HOME/bin/xmrig" && echo READY || echo MISSING); tail -25 "$HOME/xmrig.log" 2>/dev/null || true') 15 }

function Resolve-Targets([string]$Target) {
    if ($Target -eq 'all' -or -not $Target) { return @($phones) }
    if ($Target -eq 'phones') { return @($phones) }
    if ($Target -match '^phone(\d+)$') { return @($phones | Where-Object Hostname -eq $Target) }
    $devices = @(Get-Devices)
    $d = $devices | Where-Object { $_.id -eq $Target -or $_.hostname -eq $Target } | Select-Object -First 1
    if ($d -and $d.hostname -like 'phone*') { return @($phones | Where-Object Hostname -eq $d.hostname) }
    return @()
}

function Apply-Desired($p,[bool]$Force=$false) {
    $d = Get-DeviceForHost $p.Hostname
    if (-not $d) { return }
    $enabled = if ($d.quarantined) { $false } elseif ($null -ne $d.desired.miner_enabled) { [bool]$d.desired.miner_enabled } else { $false }
    $s = Get-PhoneState $p
    if (-not $s) { return }
    if ($enabled -and (-not $s.running -or $Force)) { Start-Phone $p $Force | Out-Null }
    if (-not $enabled -and $s.running) { Stop-Phone $p | Out-Null }
}

function Process-Command {
    $c = Invoke-ApiGet 'commands'
    if (-not $c -or -not $c.queue -or $c.queue.Count -eq 0) { return $false }
    $cmd = $c.queue[0]
    $targets = @(Resolve-Targets ([string]$cmd.target))
    $output = New-Object System.Collections.Generic.List[string]
    foreach ($p in $targets) {
        $r = switch ([string]$cmd.type) {
            { $_ -in @('mining-start','fresh-connect','start') } { Start-Phone $p $false; break }
            'restart' { Start-Phone $p $true; break }
            { $_ -in @('mining-stop','stop','kill-rogue') } { Stop-Phone $p; break }
            { $_ -in @('mining-status','verify-all','status','fetch-logs') } { $s=Get-PhoneState $p; [pscustomobject]@{Exit=0;Output=@($s.raw)}; break }
            'run-diagnostic' { Diagnose-Phone $p; break }
            'reconcile' { Apply-Desired $p $true; $s=Get-PhoneState $p; [pscustomobject]@{Exit=0;Output=@($s.raw)}; break }
            'reset-restart-count' { [pscustomobject]@{Exit=0;Output=@('RESET_OK')}; break }
            'reboot' { [pscustomobject]@{Exit=0;Output=@('REBOOT_SKIPPED_SAFETY')}; break }
            default { [pscustomobject]@{Exit=2;Output=@("UNSUPPORTED $($cmd.type)")} }
        }
        $output.Add("===== $($p.Hostname) / $($cmd.type) =====")
        foreach ($line in @($r.Output)) { $output.Add("$line") }
        Push-PhoneState $p | Out-Null
    }
    Invoke-ApiPost 'bridge-complete' @{ id=$cmd.id; target=$cmd.target; type=$cmd.type; result_summary="completed $($cmd.type) -> $($cmd.target)"; output=($output -join "`n") } | Out-Null
    Write-Log "Completed command $($cmd.id): $($cmd.type) -> $($cmd.target)"
    return $true
}

Reconcile-Registry
$lastRefresh = [DateTime]::MinValue
Write-Log "Windows bridge online. Fleet: $($phones.IP -join ', ')"

while ($true) {
    try {
        Invoke-ApiPost 'bridge-heartbeat' @{ hostname=$env:COMPUTERNAME; summary='Windows live bridge polling current eight-phone fleet' } | Out-Null
        $didWork = Process-Command
        if ((Get-Date) - $lastRefresh -gt [TimeSpan]::FromSeconds(30)) {
            foreach ($p in $phones) {
                Apply-Desired $p $false
                Push-PhoneState $p | Out-Null
            }
            $lastRefresh = Get-Date
        }
        Start-Sleep -Seconds $(if ($didWork) { 1 } else { 3 })
    } catch {
        Write-Log "Loop error: $($_.Exception.Message)"
        Start-Sleep -Seconds 5
    }
}
