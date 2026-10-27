# Exercise only the staged public-code download function with local fixtures.
# Never source or run the installer, real downloads, credentials or scheduler.
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$path=Join-Path $PSScriptRoot '../scripts/install-cluster-bridge-windows.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer does not parse.'}
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Install-ClusterBridgeCode'},$false)
if(-not $function){throw 'Isolated download function not found.'}
. ([scriptblock]::Create($function.Extent.Text))
$script:cases=0
$script:fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('curt-installer-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:fixtureRoot | Out-Null
function Assert-True($Value,[string]$Message){if(-not $Value){throw $Message}}
function Assert-Equal($Actual,$Expected,[string]$Message){if($Actual -cne $Expected){throw $Message}}
function Test-Case([string]$Name,[scriptblock]$Body){& $Body;$script:cases++;Write-Output "PASS $Name"}
function Reset-Fixture {
    Get-ChildItem -LiteralPath $script:fixtureRoot -File | ForEach-Object {Remove-Item -LiteralPath $_.FullName -Force}
    $script:downloads=New-Object Collections.Generic.List[object]
    $script:fixtureMode='valid'
    Set-Content -LiteralPath (Join-Path $script:fixtureRoot 'curt-cluster-bridge-windows.ps1') -Value '# old bridge' -NoNewline
    Set-Content -LiteralPath (Join-Path $script:fixtureRoot 'cluster-site-session.ps1') -Value '# old helper' -NoNewline
}
function Invoke-WebRequest {
    [CmdletBinding()]
    param([string]$Uri,[string]$OutFile,[switch]$UseBasicParsing)
    $name=([uri]$Uri).Segments[-1]
    $script:downloads.Add([pscustomobject]@{Uri=$Uri;OutFile=$OutFile})
    if($script:fixtureMode -ceq 'missing-helper' -and $name -ceq 'cluster-site-session.ps1'){throw 'fixture helper unavailable'}
    $content='# fixture public source '+('x'*1500)+"`nfunction PublicFixture { return 'safe' }`n"
    if(($script:fixtureMode -ceq 'malformed-bridge' -and $name -ceq 'curt-cluster-bridge-windows.ps1') -or
       ($script:fixtureMode -ceq 'malformed-helper' -and $name -ceq 'cluster-site-session.ps1')){$content+="function Broken {`n"}
    if($script:fixtureMode -ceq 'short-helper' -and $name -ceq 'cluster-site-session.ps1'){$content='# short'}
    Set-Content -LiteralPath $OutFile -Value $content -NoNewline
}
function Invoke-Fixture {Install-ClusterBridgeCode -Source 'https://raw.githubusercontent.com/example/fleet/test/scripts/curt-cluster-bridge-windows.ps1' -Directory $script:fixtureRoot}
function Assert-OldCode {
    Assert-Equal (Get-Content -LiteralPath (Join-Path $script:fixtureRoot 'curt-cluster-bridge-windows.ps1') -Raw) '# old bridge' 'Old bridge must remain intact.'
    Assert-Equal (Get-Content -LiteralPath (Join-Path $script:fixtureRoot 'cluster-site-session.ps1') -Raw) '# old helper' 'Old helper must remain intact.'
    Assert-True (@(Get-ChildItem -LiteralPath $script:fixtureRoot -Filter '.bridge-download-*').Count -eq 0) 'Download staging files must be removed.'
}
try {
    Test-Case 'Install validates and stages the bridge plus its sibling helper before replacement' {
        Reset-Fixture
        Invoke-Fixture
        Assert-Equal $script:downloads.Count 2 'Both public sources must be downloaded.'
        Assert-Equal $script:downloads[0].Uri 'https://raw.githubusercontent.com/example/fleet/test/scripts/cluster-site-session.ps1' 'Helper must use the same source revision and directory.'
        Assert-True ((Get-Content -LiteralPath (Join-Path $script:fixtureRoot 'cluster-site-session.ps1') -Raw).Contains('PublicFixture')) 'Helper must be installed.'
        Assert-True ((Get-Content -LiteralPath (Join-Path $script:fixtureRoot 'curt-cluster-bridge-windows.ps1') -Raw).Contains('PublicFixture')) 'Bridge must be installed.'
        Assert-True (@(Get-ChildItem -LiteralPath $script:fixtureRoot -Filter '.bridge-download-*').Count -eq 0) 'Staging files must not remain.'
    }
    Test-Case 'Unavailable, incomplete or malformed code preserves both installed files' {
        foreach($mode in @('missing-helper','short-helper','malformed-helper','malformed-bridge')) {
            Reset-Fixture
            $script:fixtureMode=$mode
            $failed=$false
            try{Invoke-Fixture}catch{$failed=$true}
            Assert-True $failed 'Unusable public code must stop installation.'
            Assert-OldCode
        }
    }
    Test-Case 'Scheduled launch keeps hidden windows and disables mining while API checks use normal site sessions' {
        $commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true))
        Assert-Equal @($commands | Where-Object {$_.GetCommandName() -ceq 'Invoke-RestMethod'}).Count 0 'Installer must not bypass the site-session helper.'
        Assert-Equal @($commands | Where-Object {$_.GetCommandName() -ceq 'Invoke-CurtClusterRequest'}).Count 2 'Summary and heartbeat checks must use site sessions.'
        $action=@($commands | Where-Object {$_.GetCommandName() -ceq 'New-ScheduledTaskAction'})
        Assert-Equal $action.Count 1 'Expected one bridge launch action.'
        Assert-True ($action[0].Extent.Text -match '-WindowStyle Hidden') 'Bridge launch must remain hidden.'
        Assert-True ($action[0].Extent.Text -match '-NoMining') 'Bridge launch must keep mining disabled.'
    }
    Write-Output "BRIDGE INSTALLER TESTS PASSED: $script:cases"
} finally {
    # Only this newly-created flat fixture directory is removed.
    Get-ChildItem -LiteralPath $script:fixtureRoot -File | ForEach-Object {Remove-Item -LiteralPath $_.FullName -Force}
    Remove-Item -LiteralPath $script:fixtureRoot
}
