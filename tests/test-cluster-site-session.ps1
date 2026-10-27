# Exercise only the public session helper with synthetic credentials and a
# local Invoke-RestMethod mock. No network, real credentials or devices.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/cluster-site-session.ps1')
$script:cases = 0

class SessionFixtureException : System.Exception {
    [object]$Response
    SessionFixtureException([string]$message,[object]$response) : base($message) { $this.Response=$response }
}
function Assert-True($Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual,$Expected,[string]$Message) { if ($Actual -cne $Expected) { throw "$Message expected=$Expected actual=$Actual" } }
function Assert-Throws([scriptblock]$Body,[string]$Message) {
    $failure=$null
    try { & $Body | Out-Null } catch { $failure=$_ }
    Assert-True ($null -ne $failure) $Message
    return $failure
}
function Test-Case([string]$Name,[scriptblock]$Body) { & $Body; $script:cases++; Write-Output "PASS $Name" }
function Reset-Fixture {
    $script:CurtSiteSession=$null; $script:CurtSiteRefresh=$null
    $script:calls=New-Object Collections.Generic.List[object]
    $script:FixtureLoginMode='success'; $script:FixtureApiError=$null
}
function Invoke-RestMethod {
    [CmdletBinding()]
    param([uri]$Uri,[string]$Method,[object]$Body,[string]$ContentType,[hashtable]$Headers,
          [Microsoft.PowerShell.Commands.WebRequestSession]$WebSession,[int]$MaximumRedirection,[int]$TimeoutSec)
    $kind=if($Uri.AbsoluteUri -ceq 'https://curtbrag.com/_site/login'){'login'}else{'api'}
    $script:calls.Add([pscustomobject]@{Kind=$kind;Uri=$Uri;Method=$Method;Body=$Body;Headers=$Headers;WebSession=$WebSession;MaximumRedirection=$MaximumRedirection;TimeoutSec=$TimeoutSec;ContentType=$ContentType})
    if($kind -ceq 'login') {
        if($script:FixtureLoginMode -ceq 'throw'){throw 'fixture login unavailable'}
        if($script:FixtureLoginMode -ceq 'false_ok'){return @{ok=$false}}
        if($script:FixtureLoginMode -ceq 'string_ok'){return @{ok='true'}}
        if($script:FixtureLoginMode -cne 'no_cookie') {
            $cookie=[Net.Cookie]::new('__Host-curtbrag_access','fixture-session','/')
            $cookie.Secure=$true; $cookie.HttpOnly=$true
            $WebSession.Cookies.Add([uri]'https://curtbrag.com/',$cookie)
        }
        return @{ok=$true}
    }
    if($script:FixtureApiError -ceq 'auth') {
        $headers=[pscustomobject]@{}
        $headers | Add-Member ScriptMethod GetValues { param($Name) if($Name -ceq 'x-curtbrag-access'){return @('password-required')}return @() }
        throw [SessionFixtureException]::new('fixture API authentication required',[pscustomobject]@{Headers=$headers})
    }
    if($script:FixtureApiError -ceq 'network'){throw 'fixture API response lost'}
    return @{ok=$true;value='fixture result'}
}
function Invoke-Fixture([string]$Address='https://curtbrag.com/api/cluster?action=queue-status',[hashtable]$Extra=@{}) {
    $request=@{Uri=$Address;Method='Get';TimeoutSec=12;Headers=@{Authorization='Bearer fixture-password'}}
    foreach($entry in $Extra.GetEnumerator()){$request[$entry.Key]=$entry.Value}
    return Invoke-CurtClusterRequest -Request $request -Password 'fixture-password'
}

Test-Case 'Reject non-site origins, custom ports, userinfo, fragments and ambiguous URL syntax before login' {
    foreach($uri in @('http://curtbrag.com/api/cluster','https://curtbrag.com:8443/api/cluster','https://user:pass@curtbrag.com/api/cluster',
        'https://www.curtbrag.com.evil.net/api/cluster','https://curtbrag.com.evil.net/api/cluster','https://curtbrag.com./api/cluster',
        'https://127.0.0.1/api/cluster','file:///api/cluster','/api/cluster','https://curtbrag.com/api/cluster#fragment',
        'https://curtbrag.com\api\cluster',"https://curtbrag.com/api/cluster`n")) {
        Reset-Fixture
        $null=Assert-Throws { Invoke-Fixture $uri } 'Invalid destination must fail.'
        Assert-Equal $script:calls.Count 0 'Rejected URL must not send login or API credentials.'
    }
}
Test-Case 'Only existing API and Netlify-function paths are allowed' {
    foreach($uri in @('https://curtbrag.com/','https://curtbrag.com/gallery/','https://curtbrag.com/apix/cluster',
        'https://curtbrag.com/api/../private','https://curtbrag.com/api/%2e%2e/private','https://curtbrag.com/api/%252e%252e/private',
        'https://curtbrag.com/api/%2fprivate','https://curtbrag.com/api/%5cprivate','https://curtbrag.com/.netlify/not-functions/cluster')) {
        Reset-Fixture
        $null=Assert-Throws { Invoke-Fixture $uri } 'Non-API path must fail.'
        Assert-Equal $script:calls.Count 0 'Path rejection occurs before any request.'
    }
    Reset-Fixture
    $null=Invoke-Fixture 'https://curtbrag.com/.netlify/functions/cluster-api?action=summary'
    Assert-Equal $script:calls.Count 2 'Approved function receives one login and one request.'
}
Test-Case 'Normal login creates an in-memory cookie session and forwards exactly one API request' {
    Reset-Fixture
    $result=Invoke-Fixture
    Assert-True ($result.ok -eq $true) 'Normal API response must be returned.'
    Assert-Equal $script:calls.Count 2 'One login and one API call required.'
    $login=$script:calls[0];$api=$script:calls[1]
    Assert-Equal $login.Kind 'login' 'Login must precede API request.'
    Assert-Equal $login.Method 'Post' 'Normal password form uses POST.'
    Assert-Equal $login.Body.password 'fixture-password' 'Only supplied synthetic password is submitted.'
    Assert-Equal $login.Headers.Origin 'https://curtbrag.com' 'Login has the fixed site origin.'
    Assert-Equal $login.ContentType 'application/x-www-form-urlencoded' 'Normal login form encoding retained.'
    Assert-True ([object]::ReferenceEquals($login.WebSession,$api.WebSession)) 'Cookie session must be reused in process memory.'
    Assert-True ($script:CurtSiteRefresh -gt (Get-Date).AddHours(22)) 'Session refresh remains bounded to23hours.'
}
Test-Case 'www is canonicalized to the approved apex before credentials are sent' {
    Reset-Fixture
    $null=Invoke-Fixture 'https://www.curtbrag.com/api/cluster?action=queue-status'
    Assert-Equal $script:calls[1].Uri.AbsoluteUri 'https://curtbrag.com/api/cluster?action=queue-status' 'www request must use the normal apex session.'
}
Test-Case 'Login and API redirects are disabled even when a caller supplies a permissive redirect value' {
    Reset-Fixture
    $null=Invoke-Fixture -Extra @{MaximumRedirection=9}
    Assert-True (($script:calls | Where-Object MaximumRedirection -ne 0).Count -eq 0) 'Credentials cannot follow HTTP redirects.'
}
Test-Case 'API requests reuse the valid session and preserve fixed payload and headers' {
    Reset-Fixture
    $null=Invoke-Fixture
    $candidate=$script:CurtSiteSession
    $null=Invoke-Fixture -Extra @{Method='Post';Body='{"action":"fixture-only"}';ContentType='application/json'}
    Assert-Equal $script:calls.Count 3 'Second request must not sign in again.'
    Assert-True ([object]::ReferenceEquals($candidate,$script:calls[2].WebSession)) 'Use the original in-memory session.'
    Assert-Equal $script:calls[2].Headers.Authorization 'Bearer fixture-password' 'Existing API credential contract is preserved.'
    Assert-Equal $script:calls[2].Body '{"action":"fixture-only"}' 'API payload remains unchanged.'
}
Test-Case 'Expired sessions receive one fresh normal login before the next explicit request' {
    Reset-Fixture
    $null=Invoke-Fixture
    $previous=$script:CurtSiteSession;$script:CurtSiteRefresh=(Get-Date).AddSeconds(-1)
    $null=Invoke-Fixture
    Assert-Equal $script:calls.Count 4 'Expiry adds one login and one requested API call.'
    Assert-True (-not [object]::ReferenceEquals($previous,$script:CurtSiteSession)) 'Expired cookie container must be replaced.'
}
Test-Case 'Failed or incomplete login never submits the requested API operation' {
    foreach($mode in @('throw','false_ok','no_cookie','string_ok')) {
        Reset-Fixture;$script:FixtureLoginMode=$mode
        $null=Assert-Throws {Invoke-Fixture} 'Invalid login must fail.'
        Assert-Equal $script:calls.Count 1 'Login failure cannot reach API.'
        Assert-True ($null -eq $script:CurtSiteSession) 'Failed login cannot leave a valid cached session.'
    }
}
Test-Case 'Authentication rejection invalidates the session without replaying a possibly accepted POST' {
    Reset-Fixture;$script:FixtureApiError='auth'
    $failure=Assert-Throws {Invoke-Fixture -Extra @{Method='Post';Body='fixture operation'}} 'API auth failure must propagate.'
    Assert-True ($failure.Exception.Message -like '*fixture API authentication required*') 'Original request failure must remain visible.'
    Assert-Equal $script:calls.Count 2 'Failed POST cannot be sent again automatically.'
    Assert-True ($null -eq $script:CurtSiteSession -and $null -eq $script:CurtSiteRefresh) 'Rejected site session must be cleared in memory.'
    $script:FixtureApiError=$null;$null=Invoke-Fixture
    Assert-Equal $script:calls.Count 4 'A later explicit request can log in again.'
}
Test-Case 'Ambiguous network failure is propagated without replay or an unnecessary sign-in' {
    Reset-Fixture;$script:FixtureApiError='network'
    $failure=Assert-Throws {Invoke-Fixture -Extra @{Method='Post';Body='fixture operation'}} 'Lost response must remain an error.'
    Assert-True ($failure.Exception.Message -like '*fixture API response lost*') 'Missing response metadata must not replace the original error.'
    Assert-Equal $script:calls.Count 2 'No automatic retry after response loss.'
    Assert-True ($null -ne $script:CurtSiteSession) 'A transport failure alone does not prove site authentication failed.'
}
Write-Output "SITE SESSION TESTS PASSED: $script:cases"
