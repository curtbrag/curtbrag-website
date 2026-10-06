#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/cluster-browser-open.ps1')
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$script:seen = $null
$capture = { param($Address) $script:seen = $Address }
$yes = { $true }
$spec = '{"url":"https://curtbrag.com/?sample=1#gallery"}' | ConvertFrom-Json
$result = Invoke-ClusterWebsiteOpen -Spec $spec -Launcher $capture -InteractiveCheck $yes
$report = $result.stdout | ConvertFrom-Json
Assert ($result.exit_code -eq 0 -and $report.launch_requested -and $report.state -eq 'launch-requested' -and -not $report.visible_screen_verified) 'Opener acceptance must not claim a verified screen.'
Assert ($script:seen -eq $spec.url) 'A normal query and fragment must stay in the navigation address.'
foreach ($json in @('{}','{"url":12}','{"url":"https://curtbrag.com/","command":"x"}','{"url":"javascript:alert(1)"}','{"url":"file:///C:/secret"}','{"url":"https://user:pass@curtbrag.com/"}','{"url":"https://127.0.0.1/"}','{"url":"https://localhost/"}','{"url":"https://foo.local/"}','{"url":"https://curtbrag.com:444/"}','{"url":"https://curtbrag.com/a b"}')) {
    $script:seen = $null
    $result = Invoke-ClusterWebsiteOpen -Spec ($json | ConvertFrom-Json) -Launcher $capture -InteractiveCheck $yes
    Assert ($result.exit_code -eq 1 -and -not ($result.stdout | ConvertFrom-Json).launch_requested -and $null -eq $script:seen) 'Invalid settings must not invoke the browser.'
}
$result = Invoke-ClusterWebsiteOpen -Spec $spec -Launcher $capture -InteractiveCheck { $false }
Assert ($result.exit_code -eq 1 -and ($result.stdout | ConvertFrom-Json).error -match 'interactive') 'An unavailable desktop must fail clearly.'
$result = Invoke-ClusterWebsiteOpen -Spec $spec -Launcher { throw 'No URL association' } -InteractiveCheck $yes
Assert ($result.exit_code -eq 1 -and ($result.stdout | ConvertFrom-Json).error -eq 'No URL association') 'An opener failure must remain a failure.'
$script:seen = $null
$result = Invoke-ClusterWebsiteOpen -Spec ('{"url":"https://curtbrag.com/$(whoami)"}' | ConvertFrom-Json) -Launcher $capture -InteractiveCheck $yes
Assert ($result.exit_code -eq 0 -and $script:seen -match '\$\(whoami\)') 'Command-shaped URL text must remain one data argument.'
'Windows browser opener validation, data arguments, desktop availability, and launch reporting passed.'
