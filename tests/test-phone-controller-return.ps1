# Extract only function ASTs. Never source bridge configuration, authentication,
# registry reconciliation, startup, or its polling loop. No network is used.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../scripts/curt-cluster-bridge-windows.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Bridge source does not parse.' }
$names = @('Get-PhoneControllerRemaining','Read-PhoneControllerExact','Write-PhoneControllerService','Read-PhoneControllerString','Read-PhoneControllerStatus','Read-PhoneControllerShell','Get-FixedPhoneControllerShell','Test-PhoneControllerOverrides','Invoke-ExistingPhoneController','Resolve-PhoneControllerTransport','Invoke-PhoneControllerReturn','Process-Command')
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object Name -In $names)
if ($functions.Count -ne $names.Count) { throw 'Missing isolated controller function.' }
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
$originalRemaining = (Get-Item Function:Get-PhoneControllerRemaining).ScriptBlock
$originalSocket = (Get-Item Function:Invoke-ExistingPhoneController).ScriptBlock
$script:cases = 0

function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ($Actual -cne $Expected) { throw "$Message expected=$Expected actual=$Actual" } }
function Assert-Throws([scriptblock]$Body, [string]$Message) {
    $threw = $false
    try { & $Body | Out-Null } catch { $threw = $true }
    Assert-True $threw $Message
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:cases++; Write-Output "PASS $Name" }
    catch { throw "FAIL ${Name}: $($_.Exception.Message)" }
}
function New-ReturnCommand([string]$Unit='phone253', $Payload=([pscustomobject]@{})) {
    return [pscustomobject]@{ id='test-command'; type='phone-return-termux'; target=$Unit; payload=$Payload }
}
function Reset-ControllerFixture([string]$Devices='', [string]$Discovery='') {
    $script:controllerCalls = New-Object Collections.Generic.List[object]
    $script:controllerFixture = @{
        devices=$Devices; discovery=$Discovery
        return=[pscustomobject]@{ExitCode=0;Output='Starting: Intent';ErrorOutput=''}
        foreground=[pscustomobject]@{ExitCode=0;Output="TERMUX_RESUMED`n";ErrorOutput=''}
    }
    $script:overrideFixture = $false
}
function Invoke-ExistingPhoneController([string]$Operation, [string]$Transport='', $DeadlineWatch=$null) {
    $script:controllerCalls.Add([pscustomobject]@{Operation=$Operation;Transport=$Transport;DeadlineWatch=$DeadlineWatch})
    if (-not $script:controllerFixture.ContainsKey($Operation)) { throw 'Unexpected socket operation' }
    $value = $script:controllerFixture[$Operation]
    if ($value -is [scriptblock]) { return & $value }
    return $value
}
function Test-PhoneControllerOverrides { return $script:overrideFixture }
function Assert-Failed($Report) {
    Assert-Equal $Report.state 'failed' 'Failed state required.'
    Assert-True ($Report.foreground_app_verified -eq $false) 'No foreground proof is allowed.'
    Assert-True ($Report.visible_screen_verified -eq $false) 'Physical visibility is never verified.'
    Assert-True ([bool]$Report.error) 'Failure needs a safe explanation.'
    Assert-True ($Report.error.Length -le 500) 'Error must be bounded.'
}

Test-Case 'Reject all computers, groups, malformed targets and target case changes' {
    foreach ($unit in @('all','phones','Alina','Nexus','viki','phone175','Phone253','phone253;reboot','192.168.1.253:39899')) {
        Reset-ControllerFixture
        Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand $unit))
        Assert-Equal $script:controllerCalls.Count 0 'Invalid target must not read a controller.'
    }
}
Test-Case 'Reject nonempty payload and arbitrary launcher overrides before any socket use' {
    foreach ($name in @('payload','cmd','command','url','serial','component','flags','settings')) {
        Reset-ControllerFixture
        $command = New-ReturnCommand
        $command | Add-Member -NotePropertyName $name -NotePropertyValue 'untrusted-override' -Force
        Assert-Failed (Invoke-PhoneControllerReturn $command)
        Assert-Equal $script:controllerCalls.Count 0 'Overrides must not reach controller.'
    }
}
Test-Case 'Reject controller overrides without reading inventory' {
    Reset-ControllerFixture
    $script:overrideFixture = $true
    Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand))
    Assert-Equal $script:controllerCalls.Count 0 'Override must stop socket access.'
}
Test-Case 'Empty inventory does not connect, launch or inspect private UI' {
    Reset-ControllerFixture
    $report = Invoke-PhoneControllerReturn (New-ReturnCommand)
    Assert-Failed $report
    Assert-Equal $report.controller_state 'disconnected' 'Empty inventory is disconnected.'
    Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices' 'Only existing inventory may be read.'
}
Test-Case 'Unauthorized matching device never receives a shell request' {
    Reset-ControllerFixture "192.168.1.253:39899`tunauthorized"
    $report = Invoke-PhoneControllerReturn (New-ReturnCommand)
    Assert-Failed $report
    Assert-Equal $report.controller_state 'unauthorized' 'Authorization state must remain explicit.'
    Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices' 'No shell without trust.'
}
Test-Case 'Authorized wrong phone does not satisfy requested identity' {
    Reset-ControllerFixture "192.168.1.191:42841`tdevice product:oneplus"
    Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand))
    Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices' 'Wrong phone must receive no shell.'
}
Test-Case 'Two authorized endpoints for one phone are ambiguous and do not launch' {
    Reset-ControllerFixture "192.168.1.253:39899`tdevice`n192.168.1.253:39900`tdevice"
    $report = Invoke-PhoneControllerReturn (New-ReturnCommand)
    Assert-Failed $report
    Assert-Equal $report.controller_state 'failed' 'Ambiguity must be explicit.'
    Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices' 'No ambiguous transport selection.'
}
Test-Case 'Fixed return through one already-authorized transport requires foreground token' {
    Reset-ControllerFixture "192.168.1.253:39899`tdevice product:oneplus"
    $report = Invoke-PhoneControllerReturn (New-ReturnCommand)
    Assert-Equal $report.kind 'phone-controller-return' 'Report kind.'
    Assert-Equal $report.unit 'phone253' 'Report unit.'
    Assert-Equal $report.state 'termux-foreground' 'System foreground proof.'
    Assert-True $report.foreground_app_verified 'Foreground must be verified by system token.'
    Assert-True (-not $report.visible_screen_verified) 'Physical screen stays unverified.'
    Assert-Equal $report.controller_state 'connected' 'Existing authorized controller.'
    Assert-True ($null -eq $report.error) 'Verified return has no error.'
    Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices,return,foreground' 'Only fixed operations may be invoked.'
    Assert-Equal $script:controllerCalls[1].Transport '192.168.1.253:39899' 'Use validated trusted serial.'
    Assert-Equal $script:controllerCalls[2].Transport '192.168.1.253:39899' 'Verify same trusted serial.'
    Assert-Equal (($report.PSObject.Properties.Name | Sort-Object) -join ',') 'controller_state,error,foreground_app_verified,kind,state,unit,visible_screen_verified' 'No raw output is published.'
}
Test-Case 'Null or empty object payload preserves fixed action only' {
    foreach ($payload in @($null, [pscustomobject]@{}, @{})) {
        Reset-ControllerFixture "192.168.1.253:39899`tdevice"
        Assert-Equal (Invoke-PhoneControllerReturn (New-ReturnCommand 'phone253' $payload)).state 'termux-foreground' 'Permitted empty metadata.'
    }
}
Test-Case 'Named mDNS trusted transport maps only through current connect-service IP' {
    foreach ($name in @('adb-phone253-random', 'adb-phone253-random._adb-tls-connect._tcp')) {
        Reset-ControllerFixture "$name`tdevice" "adb-phone253-random`t_adb-tls-connect._tcp.`t192.168.1.253:39899"
        Assert-Equal (Invoke-PhoneControllerReturn (New-ReturnCommand)).state 'termux-foreground' 'Named transport must map to expected IP.'
        Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices,discovery,return,foreground' 'Only discovery and fixed commands.'
        Assert-Equal $script:controllerCalls[2].Transport $name 'Keep exact authorized named serial.'
    }
}
Test-Case 'mDNS pairing service and wrong IP never authorize a transport' {
    foreach ($discovery in @('adb-phone253-random _adb-tls-pairing._tcp. 192.168.1.253:39899', 'adb-phone253-random _adb-tls-connect._tcp. 192.168.1.191:39899')) {
        Reset-ControllerFixture "adb-phone253-random`tdevice" $discovery
        Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand))
        Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices,discovery' 'Wrong discovery must not launch.'
    }
}
Test-Case 'Named transport advertised at two IPs is ambiguous' {
    Reset-ControllerFixture "adb-phone253-random`tdevice" "adb-phone253-random _adb-tls-connect._tcp. 192.168.1.253:39899`nadb-phone253-random _adb-tls-connect._tcp. 192.168.1.191:39899"
    Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand))
    Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices,discovery' 'Ambiguous discovery must not launch.'
}
Test-Case 'Discovery refusal cannot block a directly matching authorized endpoint' {
    Reset-ControllerFixture "192.168.1.253:39899`tdevice`nadb-other-device`tdevice"
    $script:controllerFixture.discovery = { throw 'CONTROLLER_REJECTED_REQUEST' }
    Assert-Equal (Invoke-PhoneControllerReturn (New-ReturnCommand)).state 'termux-foreground' 'Direct matching endpoint remains usable.'
}
Test-Case 'Android denial with exit zero fails and publishes no private device output' {
    Reset-ControllerFixture "192.168.1.253:39899`tdevice"
    $script:controllerFixture.return = [pscustomobject]@{ExitCode=0;Output='Error: Activity not started https://private.invalid/page';ErrorOutput='Permission Denial: hidden details'}
    $report = Invoke-PhoneControllerReturn (New-ReturnCommand)
    Assert-Failed $report
    Assert-True (($report | ConvertTo-Json -Compress) -notmatch 'private|hidden details') 'Raw details must not be reported.'
    Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices,return' 'Denied launch stops before foreground query.'
}
Test-Case 'Nonzero return and transport timeout both fail without retry' {
    foreach ($value in @([pscustomobject]@{ExitCode=1;Output='';ErrorOutput='denied'}, { throw 'CONTROLLER_DEADLINE' })) {
        Reset-ControllerFixture "192.168.1.253:39899`tdevice"
        $script:controllerFixture.return = $value
        Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand))
        Assert-Equal (($script:controllerCalls.Operation) -join ',') 'devices,return' 'No retry or other command is permitted.'
    }
}
Test-Case 'Accepted activity does not succeed when foreground is not Termux, absent or ambiguous' {
    foreach ($output in @('TERMUX_NOT_RESUMED', '', "TERMUX_RESUMED`nTERMUX_NOT_RESUMED", 'TERMUX_RESUMED untrusted-details')) {
        Reset-ControllerFixture "192.168.1.253:39899`tdevice"
        $script:controllerFixture.foreground = [pscustomobject]@{ExitCode=0;Output=$output;ErrorOutput=''}
        Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand))
        Assert-Equal (@($script:controllerCalls | Where-Object Operation -CEQ 'return').Count) 1 'Activity is requested only once.'
        Assert-Equal (@($script:controllerCalls | Where-Object Operation -CEQ 'foreground').Count) 3 'Nonmatching foreground reads stop after three observations.'
    }
}
Test-Case 'One activity request can be verified after a short bounded resumed-state delay' {
    Reset-ControllerFixture "192.168.1.253:39899`tdevice"
    $script:foregroundFixtureReplies = New-Object Collections.Generic.Queue[object]
    $script:foregroundFixtureReplies.Enqueue([pscustomobject]@{ExitCode=0;Output='TERMUX_NOT_RESUMED';ErrorOutput=''})
    $script:foregroundFixtureReplies.Enqueue([pscustomobject]@{ExitCode=0;Output='TERMUX_RESUMED';ErrorOutput=''})
    $script:controllerFixture.foreground = { return $script:foregroundFixtureReplies.Dequeue() }
    Assert-Equal (Invoke-PhoneControllerReturn (New-ReturnCommand)).state 'termux-foreground' 'Delayed foreground state can be confirmed.'
    Assert-Equal (@($script:controllerCalls | Where-Object Operation -CEQ 'return').Count) 1 'Never relaunch the activity.'
    $observations = @($script:controllerCalls | Where-Object Operation -CEQ 'foreground')
    Assert-Equal $observations.Count 2 'Stop observing when confirmed.'
    Assert-True ($null -ne $observations[0].DeadlineWatch) 'Observations have a shared deadline.'
    Assert-True ([Object]::ReferenceEquals($observations[0].DeadlineWatch,$observations[1].DeadlineWatch)) 'Retries share the same ten-second budget.'
}
Test-Case 'Foreground query denial and stderr make the result unconfirmed' {
    foreach ($value in @([pscustomobject]@{ExitCode=1;Output='TERMUX_RESUMED';ErrorOutput=''}, [pscustomobject]@{ExitCode=0;Output='TERMUX_RESUMED';ErrorOutput='denied'}, { throw 'CONTROLLER_PARTIAL_REPLY' })) {
        Reset-ControllerFixture "192.168.1.253:39899`tdevice"
        $script:controllerFixture.foreground = $value
        Assert-Failed (Invoke-PhoneControllerReturn (New-ReturnCommand))
    }
}
Test-Case 'Fixed command surface excludes payloads, navigation, permissions, power and process control' {
    Assert-Equal (Get-FixedPhoneControllerShell 'return') 'am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.termux/.app.TermuxActivity -f 0x10000000' 'Exactly one fixed activity request.'
    $foreground = Get-FixedPhoneControllerShell 'foreground'
    Assert-True ($foreground.StartsWith('dumpsys activity activities 2>/dev/null |')) 'Filter UI on the device.'
    Assert-True ($foreground.Contains('TERMUX_RESUMED') -and $foreground.Contains('TERMUX_NOT_RESUMED')) 'Only fixed foreground tokens.'
    Assert-True ($foreground -notmatch 'reboot|appops|grant|su |kill|am start|http|rm ') 'Foreground check has no mutation.'
    Assert-Throws { Get-FixedPhoneControllerShell 'arbitrary' } 'Other shell commands rejected.'
    $socketSource = ($functions | Where-Object Name -EQ 'Invoke-ExistingPhoneController').Extent.Text
    Assert-True ($socketSource.Contains("BeginConnect('127.0.0.1', 5037")) 'Existing localhost server only.'
    Assert-True ($socketSource -notmatch 'host:connect|host:pair|start-server|kill-server|Invoke-Phone|Start-Process|adb.exe') 'No reconnect or server lifecycle.'
}

if (-not ('PhoneControllerPartialStream' -as [type])) {
    Add-Type @'
using System;
using System.IO;
public class PhoneControllerPartialStream : MemoryStream {
    public PhoneControllerPartialStream(byte[] data) : base(data) { }
    public override int Read(byte[] buffer, int offset, int count) {
        return base.Read(buffer, offset, Math.Min(count, 1));
    }
}
'@
}
function New-ShellPacket([byte]$Id, [byte[]]$Payload) {
    return ,([byte[]](@($Id) + [BitConverter]::GetBytes([uint32]$Payload.Length) + $Payload))
}
Test-Case 'Exact socket reader accepts fragmented replies and rejects premature EOF' {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $stream = [PhoneControllerPartialStream]::new([byte[]]@(1,2,3,4))
    try { Assert-Equal ((Read-PhoneControllerExact $stream 4 $watch) -join ',') '1,2,3,4' 'Read all fragments.' } finally { $stream.Dispose() }
    $short = [IO.MemoryStream]::new([byte[]]@(1,2))
    try { Assert-Throws { Read-PhoneControllerExact $short 4 $watch } 'Premature EOF must fail.' } finally { $short.Dispose(); $watch.Stop() }
}
Test-Case 'Shell v2 reader separates streams and accepts only one-byte exit packets' {
    $bytes = [byte[]]((New-ShellPacket 1 ([Text.Encoding]::UTF8.GetBytes('TERMUX_RESUMED'))) + (New-ShellPacket 2 ([Text.Encoding]::UTF8.GetBytes('warning'))) + (New-ShellPacket 3 ([byte[]]@(0))))
    $stream = [PhoneControllerPartialStream]::new($bytes)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $reply = Read-PhoneControllerShell $stream $watch
        Assert-Equal $reply.ExitCode 0 'Exact exit code.'
        Assert-Equal $reply.Output 'TERMUX_RESUMED' 'Exact stdout.'
        Assert-Equal $reply.ErrorOutput 'warning' 'stderr must remain separate.'
    } finally { $stream.Dispose(); $watch.Stop() }
    foreach ($payload in @([byte[]]@(), [byte[]]@(0,0,0,0))) {
        $stream = [IO.MemoryStream]::new((New-ShellPacket 3 $payload))
        $watch = [Diagnostics.Stopwatch]::StartNew()
        try { Assert-Throws { Read-PhoneControllerShell $stream $watch } 'Malformed exit packet rejected.' } finally { $stream.Dispose(); $watch.Stop() }
    }
}
Test-Case 'Packet size limit, unknown packet and partial packet fail closed' {
    $fixtures = @([byte[]](@(1)+[BitConverter]::GetBytes([uint32]65537)), (New-ShellPacket 9 ([byte[]]@())), [byte[]]@(1,2))
    foreach ($bytes in $fixtures) {
        $stream = [IO.MemoryStream]::new($bytes)
        $watch = [Diagnostics.Stopwatch]::StartNew()
        try { Assert-Throws { Read-PhoneControllerShell $stream $watch } 'Unsafe packet rejected.' } finally { $stream.Dispose(); $watch.Stop() }
    }
}
Test-Case 'Reader deadline fails before attempting a stream read' {
    function Get-PhoneControllerRemaining { param($Watch) throw 'CONTROLLER_DEADLINE' }
    $stream = [IO.MemoryStream]::new([byte[]]@(1))
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try { Assert-Throws { Read-PhoneControllerExact $stream 1 $watch } 'Expired deadline rejected.' }
    finally { $stream.Dispose(); $watch.Stop(); Set-Item Function:Get-PhoneControllerRemaining -Value $originalRemaining }
}
Test-Case 'Service writer rechecks absolute deadline before sending its body' {
    $script:remainingFixtureReads = 0
    function Get-PhoneControllerRemaining {
        param($Watch)
        $script:remainingFixtureReads++
        if ($script:remainingFixtureReads -gt 1) { throw 'CONTROLLER_DEADLINE' }
        return 1000
    }
    $stream = New-Object IO.MemoryStream
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        Assert-Throws { Write-PhoneControllerService $stream 'host:devices-l' $watch } 'Body must stop after elapsed deadline.'
        Assert-Equal $stream.Length 4 'Only length prefix was written.'
    } finally { $stream.Dispose(); $watch.Stop(); Set-Item Function:Get-PhoneControllerRemaining -Value $originalRemaining }
}

function Invoke-ApiGet { param($Action) if ($Action -cne 'commands') { throw 'Unexpected API read' }; return [pscustomobject]@{queue=@($script:commandFixture)} }
function Invoke-ApiPost { param($Action,$Body) $script:posted.Add([pscustomobject]@{Action=$Action;Body=$Body}); return [pscustomobject]@{ok=$true} }
function Resolve-Targets { throw 'Return route must not fall through to SSH targets' }
function Push-PhoneState { throw 'Return route must not touch worker/mining state' }
function Invoke-Phone { throw 'Return route must not use Termux SSH' }
Test-Case 'Early handler explicitly completes verified system foreground result' {
    Reset-ControllerFixture "192.168.1.253:39899`tdevice"
    $script:commandFixture = New-ReturnCommand
    $script:posted = New-Object Collections.Generic.List[object]
    Assert-True (Process-Command) 'One fixed queue item handled.'
    Assert-Equal $script:posted.Count 1 'Only completion post.'
    Assert-Equal $script:posted[0].Action 'bridge-complete' 'Completion API action.'
    Assert-Equal $script:posted[0].Body.status 'completed' 'Only verified foreground is completed.'
    Assert-Equal (($script:posted[0].Body.output | ConvertFrom-Json).state) 'termux-foreground' 'Structured safe output.'
}
Test-Case 'Early handler marks accepted but unconfirmed foreground as failed' {
    Reset-ControllerFixture "192.168.1.253:39899`tdevice"
    $script:controllerFixture.foreground = [pscustomobject]@{ExitCode=0;Output='TERMUX_NOT_RESUMED';ErrorOutput=''}
    $script:commandFixture = New-ReturnCommand
    $script:posted = New-Object Collections.Generic.List[object]
    Assert-True (Process-Command) 'One fixed queue item handled.'
    Assert-Equal $script:posted.Count 1 'Only completion post.'
    Assert-Equal $script:posted[0].Body.status 'failed' 'Unconfirmed return must fail explicitly.'
    Assert-Failed ($script:posted[0].Body.output | ConvertFrom-Json)
}
Write-Output "$script:cases controller return tests passed; no bridge startup, credentials or network used."
