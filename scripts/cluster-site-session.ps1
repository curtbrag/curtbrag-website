# Normal site login for existing cluster clients. Cookies stay in process memory.
# API credentials and login forms are sent only to the existing HTTPS site.
function Invoke-CurtClusterRequest {
    param(
        [Parameter(Mandatory)][hashtable]$Request,
        [Parameter(Mandatory)][string]$Password
    )

    $uri = $null
    $address = [string]$Request.Uri
    # Existing API paths use literal names. Reject encoded path components so
    # .NET Framework and modern .NET cannot interpret traversal differently.
    if ($address -match '[\x00-\x20\x7f\\]' -or
        -not [uri]::TryCreate($address, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'https' -or -not $uri.IsDefaultPort -or $uri.UserInfo -or $uri.Fragment -or
        $uri.Host -cnotin @('curtbrag.com','www.curtbrag.com') -or
        $uri.AbsolutePath -match '%' -or
        -not ($uri.AbsolutePath.StartsWith('/api/', [StringComparison]::Ordinal) -or
              $uri.AbsolutePath.StartsWith('/.netlify/functions/', [StringComparison]::Ordinal))) {
        throw 'Cluster request destination is not approved.'
    }
    if ($uri.Host -ceq 'www.curtbrag.com') {
        $builder = [UriBuilder]::new($uri)
        $builder.Host = 'curtbrag.com'
        $uri = $builder.Uri
    }

    if (-not $script:CurtSiteSession -or -not $script:CurtSiteRefresh -or (Get-Date) -ge $script:CurtSiteRefresh) {
        $script:CurtSiteSession = $null
        $script:CurtSiteRefresh = $null
        $candidate = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        $login = Invoke-RestMethod -Uri 'https://curtbrag.com/_site/login' -Method Post `
            -Body @{password=$Password;return='/'} -ContentType 'application/x-www-form-urlencoded' `
            -Headers @{Origin='https://curtbrag.com';Accept='application/json'} -WebSession $candidate `
            -MaximumRedirection 0 -TimeoutSec 20 -ErrorAction Stop
        if ($login.ok -isnot [bool] -or $login.ok -ne $true -or
            -not $candidate.Cookies.GetCookies([uri]'https://curtbrag.com/')['__Host-curtbrag_access']) {
            throw 'Cluster site sign-in did not create a session.'
        }
        $script:CurtSiteSession = $candidate
        $script:CurtSiteRefresh = (Get-Date).AddHours(23)
    }

    $arguments = @{}
    foreach ($entry in $Request.GetEnumerator()) { $arguments[$entry.Key] = $entry.Value }
    $arguments.Uri = $uri.AbsoluteUri
    $arguments.WebSession = $script:CurtSiteSession
    $arguments.MaximumRedirection = 0
    $arguments.ErrorAction = 'Stop'
    try { Invoke-RestMethod @arguments }
    catch {
        $failure = $_
        try {
            if ($failure.Exception.Response.Headers.GetValues('x-curtbrag-access') -contains 'password-required') {
                $script:CurtSiteSession = $null
                $script:CurtSiteRefresh = $null
            }
        } catch {}
        # Do not replay a failed API request, especially a POST whose response
        # may have been lost after the server accepted it. A later explicit
        # operation can perform a normal login again.
        throw $failure
    }
}
