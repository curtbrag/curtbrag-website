# CurtBrag Cluster API Server Setup — Windows (PowerShell)
# Run this on AORUS: powershell -ExecutionPolicy Bypass -File scripts/setup-cluster-api.ps1
param(
    [string]$Password = "0735",
    [string]$Token = "",
    [string]$Wallet = "",
    [int]$Port = 3847
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  CurtBrag Cluster API Server Setup" -ForegroundColor Cyan
Write-Host ("=" * 50) -ForegroundColor Cyan
Write-Host ""

# ─── Check Prerequisites ─────────────────────────────────────────────────────

Write-Host "Checking prerequisites..." -ForegroundColor Yellow

$missing = $false

function Test-Command($name) {
    if (Get-Command $name -ErrorAction SilentlyContinue) {
        $path = (Get-Command $name).Source
        Write-Host "  [OK] $name found: $path" -ForegroundColor Green
        return $true
    } else {
        Write-Host "  [X] $name not found" -ForegroundColor Red
        return $false
    }
}

if (-not (Test-Command "node")) { $missing = $true }
if (-not (Test-Command "kubectl")) { $missing = $true }
if (-not (Test-Command "adb")) {
    Write-Host "  [!] adb not found - screen capture will be unavailable" -ForegroundColor Yellow
}
if (-not (Test-Command "ssh")) { $missing = $true }

if ($missing) {
    Write-Host "`nMissing required tools. Install them and re-run." -ForegroundColor Red
    exit 1
}

# Check Node version
$nodeVer = (node -v) -replace 'v(\d+)\..*', '$1'
if ([int]$nodeVer -lt 18) {
    Write-Host "Node.js >= 18 required (found: $(node -v))" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Node.js $(node -v)" -ForegroundColor Green

# Check kubectl
try {
    kubectl cluster-info 2>$null | Out-Null
    Write-Host "  [OK] kubectl connected to cluster" -ForegroundColor Green
} catch {
    Write-Host "  [X] kubectl cannot reach cluster" -ForegroundColor Red
    Write-Host "    Copy kubeconfig from node1: scp user@192.168.1.206:~/.kube/config ~/.kube/config"
    exit 1
}

Write-Host ""

# ─── Find API Server ─────────────────────────────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ApiDir = Join-Path (Split-Path -Parent $ScriptDir) "cluster\api"

if (-not (Test-Path (Join-Path $ApiDir "server.js"))) {
    Write-Host "API server not found at $ApiDir\server.js" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] API server found at $ApiDir\server.js" -ForegroundColor Green

# ─── Discover ADB Devices ────────────────────────────────────────────────────

if (Get-Command "adb" -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "Discovering ADB devices..." -ForegroundColor Yellow
    $devices = adb devices -l 2>$null | Select-String "device " | Where-Object { $_ -notmatch "^List" }
    foreach ($line in $devices) {
        $serial = ($line -split '\s+')[0]
        $hostname = (adb -s $serial shell hostname 2>$null).Trim()
        Write-Host "  [OK] $hostname -> $serial" -ForegroundColor Green
    }
}

Write-Host ""

# ─── Set Environment Variables ────────────────────────────────────────────────

$env:CLUSTER_WEB_PASSWORD = $Password
$env:CLUSTER_API_TOKEN = $Token
$env:XMR_WALLET = $Wallet
$env:CLUSTER_API_PORT = $Port

# ─── Start API Server ────────────────────────────────────────────────────────

Write-Host "Starting API server on port $Port..." -ForegroundColor Yellow

# Start the server in background
$serverJob = Start-Job -ScriptBlock {
    param($dir, $pw, $tok, $wal, $pt)
    $env:CLUSTER_WEB_PASSWORD = $pw
    $env:CLUSTER_API_TOKEN = $tok
    $env:XMR_WALLET = $wal
    $env:CLUSTER_API_PORT = $pt
    Set-Location $dir
    node server.js
} -ArgumentList $ApiDir, $Password, $Token, $Wallet, $Port

Start-Sleep -Seconds 3

# Test health
try {
    $health = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 5
    if ($health.status -eq "ok") {
        Write-Host "  [OK] Health check passed" -ForegroundColor Green
    }
} catch {
    Write-Host "  [X] Health check failed - checking server logs..." -ForegroundColor Red
    Receive-Job $serverJob
    exit 1
}

# Test status
try {
    $status = Invoke-RestMethod -Uri "http://localhost:$Port/api/status" -TimeoutSec 10
    if ($status.lastUpdate) {
        Write-Host "  [OK] Status endpoint returning live data" -ForegroundColor Green
    } else {
        Write-Host "  [!] Status endpoint returned but no data yet" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [!] Status endpoint: $_" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[OK] API server running on port $Port (Job ID: $($serverJob.Id))" -ForegroundColor Green
Write-Host ""

# ─── Cloudflare Tunnel ────────────────────────────────────────────────────────

if (Get-Command "cloudflared" -ErrorAction SilentlyContinue) {
    Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Yellow
    Write-Host "The tunnel URL will appear below. Paste it into curtbrag.com/cluster" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow
    Write-Host ""
    cloudflared tunnel --url "http://localhost:$Port"
} else {
    Write-Host "cloudflared not installed." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Option 1: Install cloudflared:" -ForegroundColor Cyan
    Write-Host "  winget install Cloudflare.cloudflared"
    Write-Host ""
    Write-Host "Option 2: Download from:" -ForegroundColor Cyan
    Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    Write-Host ""
    Write-Host "Then run:" -ForegroundColor Cyan
    Write-Host "  cloudflared tunnel --url http://localhost:$Port"
    Write-Host ""
    Write-Host "API server is running. Waiting for requests..." -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

    # Keep alive
    try {
        while ($true) { Start-Sleep -Seconds 60 }
    } catch {
        Stop-Job $serverJob
        Remove-Job $serverJob
    }
}
