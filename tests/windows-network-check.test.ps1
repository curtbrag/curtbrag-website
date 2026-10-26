#Requires -Version 7.0
# Load only the workload functions; never source agent startup or credentials.
# All HTTP replies are fixtures. No requests, device actions or task changes occur.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../scripts/curt-hybrid-workload-agent.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Workload agent source does not parse.' }
$names = @('Parse-JobSpec', 'Invoke-Workload')
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object Name -In $names)
if ($functions.Count -ne $names.Count) { throw 'Missing isolated workload function.' }
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }

function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ($Actual -cne $Expected) { throw "$Message expected=$Expected actual=$Actual" } }
function Invoke-WebRequest {
    [CmdletBinding()]
    param([uri]$Uri, [string]$Method, [int]$TimeoutSec, [switch]$SkipHttpErrorCheck)
    $script:requestCalls.Add([pscustomobject]@{
        uri=$Uri.AbsoluteUri; method=$Method; timeout=$TimeoutSec
        parameters=@($PSBoundParameters.Keys)
    })
    if ($script:transportError) { throw $script:transportError }
    # Match the cmdlet's default behavior so 401 fails without the correction.
    if ($script:httpStatus -ge 400 -and -not $SkipHttpErrorCheck) {
        throw "Response status code does not indicate success: $script:httpStatus."
    }
    return [pscustomobject]@{ StatusCode=$script:httpStatus }
}
function Invoke-NetworkFixture([int]$Status=200, [string]$TransportError='') {
    $script:httpStatus = $Status
    $script:transportError = $TransportError
    $script:requestCalls = [Collections.Generic.List[object]]::new()
    $result = Invoke-Workload -Type 'network-check' -Command '{}'
    Assert-Equal $script:requestCalls.Count 1 'Exactly one HEAD request is allowed.'
    $request = $script:requestCalls[0]
    Assert-Equal $request.uri 'https://curtbrag.com/' 'Check the fixed protected site.'
    Assert-Equal $request.method 'Head' 'Only request response headers.'
    Assert-Equal $request.timeout 12 'Keep the existing timeout.'
    Assert-True (-not @($request.parameters | Where-Object { $_ -notin @('Uri','Method','TimeoutSec','SkipHttpErrorCheck') }).Count) 'No credentials, headers or certificate bypass may be passed.'
    return $result
}

$protectedResult = Invoke-NetworkFixture -Status 401
Assert-Equal $protectedResult.exit_code 0 'The expected password gate proves connectivity.'
Assert-Equal $protectedResult.stderr '' 'The expected gate must not report a network failure.'
$protectedReport = $protectedResult.stdout | ConvertFrom-Json
Assert-Equal $protectedReport.site 'curtbrag.com' 'Report the checked site.'
Assert-Equal $protectedReport.http 401 'Retain the actual authorization status.'
Assert-Equal $protectedReport.reachable $true 'Explicitly report reachability.'
Assert-Equal $protectedReport.protected $true 'Explicitly report the password gate.'
Assert-True ($protectedReport.total_ms -ge 0) 'Retain measured request time.'

foreach ($status in @(200,204,301)) {
    $result = Invoke-NetworkFixture -Status $status
    $report = $result.stdout | ConvertFrom-Json
    Assert-Equal $result.exit_code 0 "HTTP $status must retain ordinary success behavior."
    Assert-Equal $result.stderr '' 'Success must have no error.'
    Assert-Equal $report.http $status 'Retain the actual HTTP status.'
    Assert-Equal $report.reachable $true 'Successful HTTP proves connectivity.'
    Assert-Equal $report.protected $false 'Ordinary success does not claim a password gate.'
}
foreach ($status in @(400,403,404,429,500,502,503)) {
    $result = Invoke-NetworkFixture -Status $status
    Assert-Equal $result.exit_code 1 "Unexpected HTTP $status must remain a failure."
    Assert-Equal $result.stdout '' 'A failed check must not publish a success report.'
    Assert-True ($result.stderr -match "curtbrag.com check failed after \d+ms:.*$status") 'Retain failure timing and HTTP status.'
}
foreach ($message in @('The request timed out.', 'No such host is known.', 'The SSL connection could not be established.')) {
    $result = Invoke-NetworkFixture -TransportError $message
    Assert-Equal $result.exit_code 1 'Transport failures must remain failures.'
    Assert-Equal $result.stdout '' 'Transport errors must not claim connectivity.'
    Assert-True ($result.stderr.EndsWith($message)) 'Retain the transport error explanation.'
}
Write-Output 'Windows network check: protected 401, ordinary HTTP, unexpected HTTP and transport failure cases passed; no network or agent startup used.'
