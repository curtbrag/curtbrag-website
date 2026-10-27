# Isolate the telemetry function only. Bridge startup, configuration, installed
# files, network, SSH, credentials and real device commands are never loaded.
$ErrorActionPreference='Stop'
$sourcePath=Join-Path $PSScriptRoot '../scripts/curt-cluster-bridge-windows.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Bridge source does not parse.'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -CEQ 'Push-PhoneState')
if($functions.Count -ne 1){throw 'One isolated Push-PhoneState function is required.'}
. ([scriptblock]::Create($functions[0].Extent.Text))
$script:cases=0
$phone=[pscustomobject]@{Hostname='phone253';IP='192.168.1.253'}
function Assert-True($Value,[string]$Message){if(-not $Value){throw $Message}}
function Assert-Equal($Actual,$Expected,[string]$Message){if($Actual -cne $Expected){throw "$Message expected=$Expected actual=$Actual"}}
function Assert-Throws([scriptblock]$Body,[string]$ExpectedMessage){
    $failure=$null
    try{& $Body|Out-Null}catch{$failure=$_.Exception.Message}
    Assert-Equal $failure $ExpectedMessage 'Exceptions retain their original propagation behavior.'
}
function Test-Case([string]$Name,[scriptblock]$Body){try{& $Body;$script:cases++;Write-Output "PASS $Name"}catch{throw "FAIL ${Name}: $($_.Exception.Message)"}}
function Reset-Fixture{
    $script:NoMining=$false;$script:MonitorOnly=$false
    $script:reads=New-Object Collections.Generic.List[object]
    $script:posts=New-Object Collections.Generic.List[object]
    $script:state=[pscustomobject]@{running=$false;hashrate=0;proc_id=0;hash='fixture-hash'}
    $script:ack=[pscustomobject]@{ok=$true;device_id='fixture-device'}
}
function Get-PhoneState($Phone){
    $script:reads.Add($Phone)
    if($script:state -is [scriptblock]){return & $script:state}
    return $script:state
}
function Invoke-ApiPost([string]$Action,$Body){
    $script:posts.Add([pscustomobject]@{Action=$Action;Body=$Body})
    if($script:ack -is [scriptblock]){return & $script:ack}
    return $script:ack
}
function Invoke-Phone{throw 'No actual SSH commands are permitted in these tests.'}
function Invoke-ApiGet{throw 'Telemetry cannot read or reconcile the registry.'}
function Ensure-Device{throw 'Telemetry cannot create a registry entry.'}
function Reconcile-Registry{throw 'Telemetry cannot reconcile the registry.'}
function Start-Phone{throw 'Telemetry cannot start mining or a worker.'}
function Apply-Desired{throw 'Telemetry cannot change desired state.'}

Test-Case 'NoMining avoids all SSH state reads and registry posts in normal and MonitorOnly modes'{
    foreach($monitor in @($false,$true)){
        Reset-Fixture;$script:NoMining=$true;$script:MonitorOnly=$monitor
        $script:state={throw 'An obsolete mining probe was attempted.'}
        $script:ack={throw 'An obsolete registry post was attempted.'}
        $r=Push-PhoneState $phone
        Assert-True ($r -is [bool] -and $r -eq $false) 'Skipped mining telemetry cannot report successful synchronization.'
        Assert-Equal $script:reads.Count 0 'NoMining must avoid the SSH-backed state function.'
        Assert-Equal $script:posts.Count 0 'NoMining must not touch or create registry records.'
    }
}
Test-Case 'An unavailable phone state returns false without posting or creating metadata'{
    Reset-Fixture;$script:state=$null
    $r=Push-PhoneState $phone
    Assert-True ($r -is [bool] -and $r -eq $false) 'No observation is not success.'
    Assert-Equal $script:reads.Count 1 'One existing state read is used.'
    Assert-Equal $script:posts.Count 0 'No registry update follows an unavailable observation.'
}
Test-Case 'A normal explicit boolean acknowledgement succeeds after exactly one unchanged telemetry post'{
    Reset-Fixture
    $r=Push-PhoneState $phone
    Assert-True ($r -is [bool] -and $r -eq $true) 'Explicit ok true acknowledges synchronization.'
    Assert-Equal $script:reads.Count 1 'Normal mode reads state once.'
    Assert-Equal $script:posts.Count 1 'Normal mode posts once and does not retry.'
    $p=$script:posts[0]
    Assert-Equal $p.Action 'bridge-touch-device' 'The normal existing route is retained.'
    Assert-Equal $p.Body.hostname 'phone253' 'The observed hostname remains the request target.'
    Assert-Equal (($p.Body.Keys|Sort-Object)-join ',') 'hostname,observed' 'No desired state or registry creation settings are sent.'
    Assert-Equal $p.Body.observed.xmrig_running $false 'Existing read-only observation is preserved.'
    Assert-Equal $p.Body.observed.workload_enabled $false 'Observed enablement follows actual process state.'
    Assert-Equal $p.Body.observed.hashrate_60s 0 'The telemetry values remain unchanged.'
}
Test-Case 'Null, false and missing acknowledgements cannot falsely report success or trigger retries'{
    foreach($ack in @($null,$false,$true,[pscustomobject]@{},[pscustomobject]@{ok=$false},[pscustomobject]@{error='no device with hostname phone253'})){
        Reset-Fixture;$script:ack=$ack
        $r=Push-PhoneState $phone
        Assert-True ($r -is [bool] -and $r -eq $false) 'Only an explicit boolean ok true is successful.'
        Assert-Equal $script:reads.Count 1 'No state-read replay occurs after failed acknowledgement.'
        Assert-Equal $script:posts.Count 1 'No POST replay or registry-creation fallback occurs.'
    }
}
Test-Case 'Truthy strings, numbers and collections are not explicit boolean acknowledgements'{
    foreach($ack in @([pscustomobject]@{ok='true'},[pscustomobject]@{ok=1},[pscustomobject]@{ok=@($true)},[pscustomobject]@{ok=[pscustomobject]@{value=$true}})){
        Reset-Fixture;$script:ack=$ack
        $r=Push-PhoneState $phone
        Assert-True ($r -is [bool] -and $r -eq $false) 'Acknowledgement does not coerce another value type to true.'
        Assert-Equal $script:posts.Count 1 'Malformed replies never replay a POST.'
    }
}
Test-Case 'Actual process state remains an observation and cannot independently claim API success'{
    Reset-Fixture;$script:state=[pscustomobject]@{running=$true;hashrate=12.5;proc_id=321;hash='fixture-hash'};$script:ack=$null
    $r=Push-PhoneState $phone
    Assert-True ($r -is [bool] -and $r -eq $false) 'A process observation does not prove registry synchronization.'
    Assert-Equal $script:posts[0].Body.observed.xmrig_running $true 'No command changes the observed process.'
    Assert-Equal $script:posts[0].Body.observed.custom_pid 321 'Existing read-only telemetry stays intact.'
}
Test-Case 'State-read exceptions propagate without an API update or fallback action'{
    Reset-Fixture;$script:state={throw 'fixture-state-read-failed'}
    Assert-Throws {Push-PhoneState $phone} 'fixture-state-read-failed'
    Assert-Equal $script:reads.Count 1 'One state read was attempted.'
    Assert-Equal $script:posts.Count 0 'A failed read cannot be synchronized.'
}
Test-Case 'Unexpected API exceptions propagate once without claiming success or replaying the update'{
    Reset-Fixture;$script:ack={throw 'fixture-api-post-failed'}
    Assert-Throws {Push-PhoneState $phone} 'fixture-api-post-failed'
    Assert-Equal $script:reads.Count 1 'A thrown acknowledgement failure does not replay the observation.'
    Assert-Equal $script:posts.Count 1 'A thrown acknowledgement failure does not replay its POST.'
}
Test-Case 'MonitorOnly retains its existing read-only observations when NoMining is absent'{
    Reset-Fixture;$script:MonitorOnly=$true
    $r=Push-PhoneState $phone
    Assert-True ($r -is [bool] -and $r -eq $true) 'Existing monitoring telemetry can still be acknowledged.'
    Assert-Equal $script:reads.Count 1 'MonitorOnly keeps the existing observation behavior.'
    Assert-Equal $script:posts.Count 1 'MonitorOnly posts observations without executing a device command.'
    Assert-Equal $script:posts[0].Action 'bridge-touch-device' 'Only the existing metadata update occurs.'
}
Write-Output "PASS $script:cases NoMining telemetry cases; only mocked observations and API acknowledgements were used."
