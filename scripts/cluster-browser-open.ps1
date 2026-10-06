#Requires -Version 7.0
function Invoke-ClusterWebsiteOpen {
    param(
        $Spec,
        [scriptblock]$Launcher = { param($Address) Start-Process -FilePath $Address -ErrorAction Stop },
        [scriptblock]$InteractiveCheck = { [Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0 }
    )
    $report = [ordered]@{ kind='website-browser-open'; url=$null; platform='windows'; state='failed'; launch_requested=$false; visible_screen_verified=$false; launcher='default-browser'; error=$null }
    try {
        if (-not ($Spec.url -is [string]) -or @($Spec.PSObject.Properties.Name).Count -ne 1) { throw 'Settings must contain only one HTTPS URL string.' }
        $address = [string]$Spec.url
        $report.url = $address
        if ($address.Length -gt 2048 -or $address -match '[\x00-\x20\x7f\\]') { throw 'Use an HTTPS address of up to 2048 characters without spaces or control characters.' }
        $page = $null
        if (-not [uri]::TryCreate($address, [UriKind]::Absolute, [ref]$page) -or $page.Scheme -ne 'https' -or $page.UserInfo -or $page.Port -ne 443) { throw 'Use a public HTTPS page without embedded credentials or a custom port.' }
        $hostName = $page.DnsSafeHost.TrimEnd('.').ToLowerInvariant()
        $ip = $null
        if ($hostName -notmatch '\.' -or $hostName -match '(^|\.)(localhost|local|internal|test|invalid)$' -or $hostName -match '^[\d.]+$' -or [Net.IPAddress]::TryParse($hostName, [ref]$ip)) { throw 'Use a public website hostname.' }
        if ($hostName -notmatch '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$') { throw 'Use a valid website hostname.' }
        if (-not (& $InteractiveCheck)) { throw 'No interactive Windows desktop is available. The browser was not opened.' }
        $null = & $Launcher $page.AbsoluteUri
        $report.state = 'launch-requested'; $report.launch_requested = $true
        return [ordered]@{ exit_code=0; stdout=($report | ConvertTo-Json -Compress); stderr='' }
    } catch {
        $report.error = $_.Exception.Message.Substring(0, [Math]::Min(400, $_.Exception.Message.Length))
        return [ordered]@{ exit_code=1; stdout=($report | ConvertTo-Json -Compress); stderr='' }
    }
}
