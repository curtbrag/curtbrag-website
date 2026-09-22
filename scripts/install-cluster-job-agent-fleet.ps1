param(
    [string]$ApiKey = $env:CLUSTER_API_KEY,
    [switch]$SkipHostKeyCheck
)

$ErrorActionPreference = 'Continue'
$Installer = 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/install-cluster-job-agent.sh'

if ($ApiKey -and ($ApiKey -notmatch '^[A-Za-z0-9._-]{16,256}$')) {
    throw 'CLUSTER_API_KEY has an unexpected format. Nothing was changed.'
}

if (-not $ApiKey) {
    Write-Host 'Using each node existing CLUSTER_API_KEY from ~/.cluster-env.' -ForegroundColor DarkGray
}

$Nodes = @(
    [pscustomobject]@{ Name = 'phone173'; Address = '192.168.1.173'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'phone174'; Address = '192.168.1.174'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'phone176'; Address = '192.168.1.176'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'phone177'; Address = '192.168.1.177'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'phone191'; Address = '192.168.1.191'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'phone195'; Address = '192.168.1.195'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'phone253'; Address = '192.168.1.253'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'phone254'; Address = '192.168.1.254'; User = 'u0_a191'; Port = 8022 }
    [pscustomobject]@{ Name = 'Alina'; Address = '192.168.1.193'; User = 'neo'; Port = 22 }
    [pscustomobject]@{ Name = 'Nexus'; Address = '192.168.1.192'; User = 'neo'; Port = 22 }
    [pscustomobject]@{ Name = 'SteamDeck'; Address = '192.168.1.166'; User = 'deck'; Port = 22 }
)

$CommonSshArgs = @(
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5'
)

if ($SkipHostKeyCheck) {
    $CommonSshArgs += @('-o', 'StrictHostKeyChecking=accept-new')
}

$Results = [System.Collections.Generic.List[object]]::new()

Write-Host 'Curt Cluster distributed-job deployment' -ForegroundColor Cyan
Write-Host ('Targets: ' + $Nodes.Count)
Write-Host ''

foreach ($Node in $Nodes) {
    $Target = $Node.User + '@' + $Node.Address
    Write-Host ('[' + $Node.Name + '] ' + $Target + ':' + $Node.Port) -ForegroundColor Cyan

    if ($ApiKey) {
        $RemoteCommand = "export CLUSTER_API_KEY='$ApiKey'; curl -fsSL '$Installer' | sh -s -- '$($Node.Name)'"
    }
    else {
        $RemoteCommand = "curl -fsSL '$Installer' | sh -s -- '$($Node.Name)' </dev/null"
    }

    $Output = & ssh @CommonSshArgs -p $Node.Port $Target $RemoteCommand 2>&1
    $ExitCode = $LASTEXITCODE
    $Succeeded = $ExitCode -eq 0

    if ($Succeeded) {
        $Status = 'ONLINE'
        Write-Host ('  ONLINE - ' + $Node.Name) -ForegroundColor Green
    }
    else {
        $Status = 'FAILED'
        Write-Host ('  FAILED - ' + $Node.Name + ' (SSH exit ' + $ExitCode + ')') -ForegroundColor Red
    }

    $Results.Add([pscustomobject]@{
        Node = $Node.Name
        IP = $Node.Address
        Port = $Node.Port
        Status = $Status
        Detail = (($Output | Select-Object -Last 3) -join ' | ')
    })
}

Write-Host ''
$Results | Format-Table Node, IP, Port, Status -AutoSize
$Failed = @($Results | Where-Object { $_.Status -eq 'FAILED' })

if ($Failed.Count -gt 0) {
    Write-Host ('Finished with ' + $Failed.Count + ' failure(s).') -ForegroundColor Yellow
    foreach ($Item in $Failed) {
        Write-Host ('- ' + $Item.Node + ': ' + $Item.Detail)
    }
    Write-Host 'Wake or reconnect failed nodes, then run this same script again.' -ForegroundColor Yellow
    exit 1
}

Write-Host 'All 11 cluster job agents are online.' -ForegroundColor Green
Write-Host 'Open https://curtbrag.com/cluster/dashboard/ and use the Jobs tab.' -ForegroundColor Green
