param(
    [string]$ConfigPath = "$env:LOCALAPPDATA\CurtCluster\bridge-config.json",
    [string]$RunnerPath = (Join-Path $PSScriptRoot 'cluster-phone-follow.cjs'),
    [string]$NodePath,
    [string]$AdbPath
)

# This helper only runs the opt-in URL follower. It never starts the bridge,
# workers, recovery watcher, mining software, or an Android debugging server.
$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, 'Local\CurtClusterPhoneFollow')
$owned = $false
$child = $null
try {
    try { $owned = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    if (-not $NodePath) {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($node) { $NodePath = $node.Source }
    }
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $RunnerPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -or
        -not $AdbPath -or -not (Test-Path -LiteralPath $AdbPath -PathType Leaf)) {
        throw 'Phone follower prerequisites are unavailable.'
    }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $api = if ($config.api_url) { [string]$config.api_url } else { 'https://curtbrag.com/.netlify/functions/cluster-api' }
    if ($api -ne 'https://curtbrag.com/.netlify/functions/cluster-api') {
        throw 'Phone follower requires the existing CurtBrag production API.'
    }
    # Reuse the bridge's existing protected configuration in its normal user
    # context. The owner credential is never a command-line argument or file.
    $secure = ConvertTo-SecureString $config.password_cipher
    $password = [System.Net.NetworkCredential]::new('', $secure).Password
    if (-not $password) { throw 'Phone follower owner session is unavailable.' }
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodePath
    $start.Arguments = '"' + $RunnerPath.Replace('"', '') + '"'
    $start.WorkingDirectory = $PSScriptRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [System.Diagnostics.Process]::Start($start)
    # Drain sanitized process output without saving browsing data or secrets.
    $child.BeginOutputReadLine()
    $child.BeginErrorReadLine()
    $payload = @{
        password = $password
        api_url = $api
        swarm_api = 'https://curtbrag.com/api/cluster'
        adb_path = $AdbPath
    } | ConvertTo-Json -Compress
    $child.StandardInput.WriteLine($payload)
    $child.StandardInput.Close()
    $payload = $null
    $password = $null
    $config = $null
    $child.WaitForExit()
    exit $child.ExitCode
}
catch {
    # Do not include exception text: process/configuration errors may contain
    # private values. The dashboard reports the stale runner heartbeat.
    Write-Error 'The phone follower stopped. Check its local prerequisites.' -ErrorAction Continue
    exit 2
}
finally {
    if ($child -and -not $child.HasExited) { $child.Kill() }
    if ($child) { $child.Dispose() }
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
