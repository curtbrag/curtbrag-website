# Extract only metadata functions. Never source bridge startup, configuration,
# credentials, real sockets, scheduler, SSH, phone input or permission changes.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../scripts/curt-cluster-bridge-windows.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Bridge source does not parse.' }
$names=@('Get-PhoneControllerRemaining','Resolve-PhoneControllerTransport','Get-PhoneControllerAvailability')
$functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -In $names)
if ($functions.Count -ne $names.Count) { throw 'Missing isolated availability function.' }
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
$script:realRemaining=(Get-Item Function:Get-PhoneControllerRemaining).ScriptBlock
$script:cases=0
$canonical=@('phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254')
function Assert-True($Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual,$Expected,[string]$Message) { if ($Actual -cne $Expected) { throw "$Message expected=$Expected actual=$Actual" } }
function Test-Case([string]$Name,[scriptblock]$Body) { try { & $Body; $script:cases++; Write-Output "PASS $Name" } catch { throw "FAIL ${Name}: $($_.Exception.Message)" } }
function Reset-Fixture([string]$Devices='',[string]$Discovery='') {
    $script:calls=New-Object Collections.Generic.List[object]
    $script:replies=@{devices=$Devices;discovery=$Discovery}
    $script:override=$false
    $script:remainingFailure=$false
}
function Test-PhoneControllerOverrides { return $script:override }
function Invoke-ExistingPhoneController([string]$Operation,[string]$Transport='',$DeadlineWatch=$null,[string]$Url='') {
    $script:calls.Add([pscustomobject]@{Operation=$Operation;Transport=$Transport;Url=$Url;Watch=$DeadlineWatch})
    Assert-True ($Operation -cin @('devices','discovery')) 'Only read-only smart-socket services may be queried.'
    Assert-Equal $Transport '' 'A metadata query cannot select a device transport.'
    Assert-Equal $Url '' 'A metadata query cannot contain a URL.'
    Assert-True ($DeadlineWatch -is [Diagnostics.Stopwatch] -and $DeadlineWatch.IsRunning) 'One live absolute-deadline watch is mandatory.'
    $reply=$script:replies[$Operation]
    if ($reply -is [scriptblock]) { return & $reply }
    return $reply
}
function Get-PhoneControllerRemaining($Watch) {
    if ($script:remainingFailure) { throw 'CONTROLLER_DEADLINE' }
    return & $script:realRemaining $Watch
}
function Assert-Shape($Report) {
    Assert-Equal (($Report.PSObject.Properties.Name | Sort-Object) -join ',') 'checked_at,devices,schema,server_state' 'Only approved snapshot fields leave the bridge.'
    Assert-Equal $Report.schema 1 'Versioned availability schema is fixed.'
    Assert-Equal @($Report.devices).Count 8 'All eight worker states are present.'
    Assert-Equal (($Report.devices | ForEach-Object unit) -join ',') ($canonical -join ',') 'Only canonical workers occur, in stable order.'
    [DateTimeOffset]$checked=[DateTimeOffset]::MinValue
    Assert-True ([DateTimeOffset]::TryParse($Report.checked_at,[ref]$checked)) 'A timestamp is required.'
    Assert-Equal $checked.Offset.TotalSeconds 0 'Timestamp uses UTC.'
    Assert-True ([Math]::Abs(([DateTimeOffset]::UtcNow-$checked).TotalSeconds) -lt 30) 'Timestamp describes this bounded read.'
    foreach ($device in $Report.devices) {
        Assert-Equal (($device.PSObject.Properties.Name | Sort-Object) -join ',') 'state,unit' 'No serial, address or private metadata is published.'
        Assert-True ($device.state -cin @('connected','unauthorized','disconnected','unknown')) 'Device states use the fixed vocabulary.'
    }
    foreach ($call in $script:calls) { Assert-True (-not $call.Watch.IsRunning) 'Absolute deadline watch is disposed after the observation.' }
}
function Assert-AllStates($Report,[string]$State) {
    Assert-Shape $Report
    foreach ($device in $Report.devices) { Assert-Equal $device.state $State 'Every worker must have the expected conservative state.' }
}

Test-Case 'An empty existing server reports eight disconnected workers without phone input' {
    Reset-Fixture
    $r=Get-PhoneControllerAvailability
    Assert-AllStates $r 'disconnected'; Assert-Equal $r.server_state 'available' 'Successful empty inventory is distinct from server absence.'
    Assert-Equal $script:calls.Count 1 'Empty inventory needs only the devices metadata read.'
}
Test-Case 'The personal phone is excluded and its name or serial never leaves telemetry' {
    Reset-Fixture "192.168.1.237:38033`tdevice product:private_product model:SM_S948U device:private_name"
    $r=Get-PhoneControllerAvailability
    Assert-AllStates $r 'disconnected'; Assert-Equal $r.server_state 'available' 'The existing server is reachable.'
    Assert-True (($r|ConvertTo-Json -Depth 5 -Compress) -notmatch '237|38033|SM_S948U|private_') 'Personal-device details must not be published.'
}
Test-Case 'Unique IP transports distinguish authorized, unauthorized and offline workers' {
    Reset-Fixture "192.168.1.173:31001`tdevice`n192.168.1.174:31002`tunauthorized`n192.168.1.176:31003`toffline"
    $r=Get-PhoneControllerAvailability;Assert-Shape $r
    Assert-Equal $r.devices[0].state 'connected' 'A unique authorized transport is usable.'
    Assert-Equal $r.devices[1].state 'unauthorized' 'A rejected connection is explicit.'
    Assert-Equal $r.devices[2].state 'disconnected' 'Offline input is unavailable.'
    Assert-Equal $r.devices[6].state 'disconnected' 'An absent worker is disconnected.'
}
Test-Case 'Multiple authorized transports for one worker remain unknown' {
    Reset-Fixture "192.168.1.253:31001`tdevice`n192.168.1.253:31002`tdevice"
    $r=Get-PhoneControllerAvailability;Assert-Shape $r
    Assert-Equal $r.devices[6].state 'unknown' 'A transport ambiguity cannot be advertised as connected.'
    Assert-Equal $r.devices[0].state 'disconnected' 'A bounded per-worker ambiguity does not invent other connections.'
}
Test-Case 'Repeated identical inventory lines do not invent transport ambiguity' {
    Reset-Fixture "192.168.1.253:31001`tdevice`n192.168.1.253:31001`tdevice"
    $r=Get-PhoneControllerAvailability;Assert-Shape $r
    Assert-Equal $r.devices[6].state 'connected' 'The resolver deduplicates identical authorized serials.'
}
Test-Case 'mDNS aliases resolve through one shared deadline and only approved metadata queries' {
    Reset-Fixture "adb-worker._adb-tls-connect._tcp`tdevice model:private_worker`nadb-personal._adb-tls-connect._tcp`tdevice model:private_personal" "adb-worker`t_adb-tls-connect._tcp`t192.168.1.253:31001`nadb-personal`t_adb-tls-connect._tcp`t192.168.1.237:38033"
    $r=Get-PhoneControllerAvailability;Assert-Shape $r
    Assert-Equal $r.devices[6].state 'connected' 'Unique discovery maps the worker.'
    Assert-Equal $r.devices[0].state 'disconnected' 'No unrelated worker is marked connected.'
    Assert-Equal $script:calls.Count 2 'Exactly devices and required discovery are read.'
    Assert-True ([object]::ReferenceEquals($script:calls[0].Watch,$script:calls[1].Watch)) 'Both socket reads share one total deadline.'
    Assert-True (($r|ConvertTo-Json -Depth 5 -Compress) -notmatch 'adb-worker|adb-personal|private_|192\.168|38033|31001') 'Raw discovery and model values stay local.'
}
Test-Case 'Failed discovery leaves every worker unknown even beside an IP connection' {
    Reset-Fixture "192.168.1.253:31001`tdevice`nadb-unresolved`tdevice"
    $script:replies.discovery={throw 'discovery-error-with-sensitive-address'}
    $r=Get-PhoneControllerAvailability;Assert-AllStates $r 'unknown'
    Assert-Equal $r.server_state 'available' 'Devices metadata worked, while worker mapping is unknown.'
    Assert-True (($r|ConvertTo-Json -Depth 5 -Compress) -notmatch 'sensitive|discovery-error') 'Raw exception text is not telemetry.'
}
Test-Case 'Successful discovery without the device alias fails closed' {
    Reset-Fixture "192.168.1.253:31001`tdevice`nadb-missing`tdevice" "adb-other`t_adb-tls-connect._tcp`t192.168.1.174:31001"
    Assert-AllStates (Get-PhoneControllerAvailability) 'unknown'
}
Test-Case 'An alias advertised for two addresses cannot create any usable connection' {
    Reset-Fixture "adb-worker`tdevice" "adb-worker`t_adb-tls-connect._tcp`t192.168.1.253:31001`nadb-worker`t_adb-tls-connect._tcp`t192.168.1.174:31002"
    Assert-AllStates (Get-PhoneControllerAvailability) 'unknown'
}
Test-Case 'Invalid discovery ports and addresses cannot resolve an alias' {
    foreach ($endpoint in @('192.168.1.253:0','192.168.1.253:65536','192.168.1.999:31001')) {
        Reset-Fixture "adb-worker`tdevice" "adb-worker`t_adb-tls-connect._tcp`t$endpoint"
        Assert-AllStates (Get-PhoneControllerAvailability) 'unknown'
    }
}
Test-Case 'Malformed inventories and oversized record counts cannot claim disconnection or readiness' {
    foreach ($devices in @('not-controller-protocol',"192.168.1.253:31001`tunexpected",((1..65|ForEach-Object {"192.168.1.253:$_`tdevice"}) -join "`n"))) {
        Reset-Fixture $devices
        $r=Get-PhoneControllerAvailability;Assert-AllStates $r 'unknown'
        Assert-Equal $r.server_state 'unknown' 'An incomplete or malformed inventory is unknown.'
    }
}
Test-Case 'A refused existing socket reports unavailable without starting or connecting a controller' {
    Reset-Fixture;$script:replies.devices={throw [Net.Sockets.SocketException]::new(10061)}
    $r=Get-PhoneControllerAvailability;Assert-AllStates $r 'unknown'
    Assert-Equal $r.server_state 'unavailable' 'The existing local server could not be reached.'
    Assert-Equal $script:calls.Count 1 'One metadata attempt only; no reconnect or retry.'
}
Test-Case 'Protocol and absolute deadline failures remain unknown' {
    Reset-Fixture;$script:replies.devices={throw 'CONTROLLER_PARTIAL_REPLY'}
    $r=Get-PhoneControllerAvailability;Assert-AllStates $r 'unknown';Assert-Equal $r.server_state 'unknown' 'Protocol failure cannot prove absence.'
    Reset-Fixture "192.168.1.253:31001`tdevice";$script:remainingFailure=$true
    $r=Get-PhoneControllerAvailability;Assert-AllStates $r 'unknown';Assert-Equal $r.server_state 'unknown' 'Expired total deadline cannot preserve partial connected claims.'
}
Test-Case 'Identity and endpoint overrides prevent even metadata access' {
    Reset-Fixture;$script:override=$true
    $r=Get-PhoneControllerAvailability;Assert-AllStates $r 'unknown'
    Assert-Equal $r.server_state 'unknown' 'Overridden controller configuration is not trusted.'
    Assert-Equal $script:calls.Count 0 'No socket query is made with controller overrides.'
}
Test-Case 'Startup and MonitorOnly polling publish read-only availability without device command execution' {
    Reset-Fixture
    $script:posts=New-Object Collections.Generic.List[object]
    function Invoke-ApiPost([string]$Action,$Body) { $script:posts.Add([pscustomobject]@{Action=$Action;Body=$Body});return [pscustomobject]@{ok=$true} }
    function Start-Sleep { param($Seconds,$Milliseconds) }
    function Process-Command { throw 'MonitorOnly cannot execute commands.' }
    function Apply-Desired { throw 'MonitorOnly cannot reconcile devices.' }
    function Get-FleetConnections { throw 'A fresh existing fleet snapshot is already present.' }
    function Push-PhoneState { throw 'This fixture has no worker-state refresh due.' }
    Assert-True ($ast.Extent.Text.Contains('$bridgeVersion = ''2.6.1''')) 'Updated telemetry is advertised by bridge2.6.1.'
    $bridgeVersion='2.6.1';$MonitorOnly=$true;$NoMining=$false
    $startup=@($ast.EndBlock.Statements | Where-Object {$_.Extent.Text -cmatch "^Invoke-ApiPost 'bridge-heartbeat'"})
    Assert-Equal $startup.Count 1 'One startup heartbeat is present.'
    . ([scriptblock]::Create($startup[0].Extent.Text))
    Assert-Equal $script:posts.Count 1 'Startup publishes one heartbeat.'
    Assert-Equal $script:posts[0].Body.phone_controller.schema 1 'Startup includes the read-only snapshot.'
    Assert-AllStates $script:posts[0].Body.phone_controller 'disconnected'
    $loops=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.WhileStatementAst]})
    Assert-Equal $loops.Count 1 'One normal polling loop exists.'
    $phones=@();$fleetConnections=$null;$lastFleetCheck=Get-Date;$lastHeartbeat=[DateTime]::MinValue;$lastRefresh=Get-Date
    $body=$loops[0].Body.Extent.Text
    . ([scriptblock]::Create($body.Substring(1,$body.Length-2)))
    Assert-Equal $script:posts.Count 2 'Normal MonitorOnly heartbeat still publishes availability.'
    Assert-Equal $script:posts[1].Body.phone_controller.schema 1 'Polling includes the metadata snapshot.'
    Assert-AllStates $script:posts[1].Body.phone_controller 'disconnected'
    Assert-True ($script:posts[1].Body.summary -match 'monitoring only') 'Mode protections stay explicit.'
    Assert-Equal $script:calls.Count 2 'Only two mocked devices metadata queries occurred.'
}
Write-Output "PASS $script:cases controller-availability cases; all controller replies mocked, no real sockets, devices or credentials accessed."
