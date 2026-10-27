# Isolate function ASTs only. Do not source startup, credentials or polling.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../scripts/curt-cluster-bridge-windows.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Bridge source does not parse.' }
$names = @('Get-FixedPhoneControllerShell','Assert-PhoneControllerPublicUrl','New-PhoneControllerActionReport','Get-PhoneControllerActionRequest','Get-PhoneNativeCommandPath','Get-PhoneNativeRequestDigest','Write-PhoneNativeRecord','Read-PhoneNativeRecord','Invoke-PhoneControllerAction','Resolve-PhoneControllerTransport','Process-Command')
$functions = @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -In $names)
if ($functions.Count -ne $names.Count) { throw 'Missing isolated native-controller function.' }
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
$script:cases = 0
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('curt-native-controller-tests-' + [Guid]::NewGuid().ToString('N'))))
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $testRoot.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($testRoot) -notmatch '^curt-native-controller-tests-[a-f0-9]{32}$') { throw 'Test temporary path did not verify.' }
$null = [IO.Directory]::CreateDirectory($testRoot)

function Assert-True($Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual,$Expected,[string]$Message) { if ($Actual -cne $Expected) { throw "$Message expected=$Expected actual=$Actual" } }
function Assert-Throws([scriptblock]$Body,[string]$Message) { $threw=$false; try { & $Body | Out-Null } catch { $threw=$true }; Assert-True $threw $Message }
function Test-Case([string]$Name,[scriptblock]$Body) { try { & $Body; $script:cases++; Write-Output "PASS $Name" } catch { throw "FAIL ${Name}: $($_.Exception.Message)" } }
function New-NativeCommand([string]$Type='phone-back',[string]$Unit='phone253',$Payload=([pscustomobject]@{})) {
    return [pscustomobject]@{id='0123456789abcdef0123456789abcdef';request_id='request-fixture';type=$Type;target=$Unit;payload=$Payload}
}
function Reset-Fixture([string]$Devices="192.168.1.253:39899`tdevice") {
    $script:base = Join-Path $testRoot ([Guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($script:base)
    $script:calls = New-Object Collections.Generic.List[object]
    $script:replies = @{
        devices=$Devices; discovery=''
        back=[pscustomobject]@{ExitCode=0;Output='';ErrorOutput=''}
        'open-website'=[pscustomobject]@{ExitCode=0;Output="Starting: Intent`nStatus: ok`nActivity: org.browser/.Main`nComplete`n";ErrorOutput=''}
    }
    $script:override = $false
}
function Invoke-ExistingPhoneController([string]$Operation,[string]$Transport='',$DeadlineWatch=$null,[string]$Url='') {
    $script:calls.Add([pscustomobject]@{Operation=$Operation;Transport=$Transport;Url=$Url})
    if (-not $script:replies.ContainsKey($Operation)) { throw 'Unexpected fixture operation' }
    $value = $script:replies[$Operation]
    if ($value -is [scriptblock]) { return & $value }
    return $value
}
function Test-PhoneControllerOverrides { return $script:override }
function Assert-Failed($Report) {
    Assert-Equal $Report.state 'failed' 'Failure state required.'
    Assert-True ($Report.request_accepted -eq $false) 'Failure cannot claim accepted input.'
    Assert-True ($Report.foreground_app_verified -eq $false -and $Report.visible_screen_verified -eq $false) 'Never invent visibility evidence.'
    Assert-True ([bool]$Report.error -and $Report.error.Length -le 500) 'Failure explanation must be bounded.'
}

try {
    Test-Case 'Reject personal phone, groups, computers, case changes and injected targets' {
        foreach ($unit in @('all','phones','S26','Curtis S26 Ultra','Alina','RenderRig','Phone253','phone175','phone253;reboot','192.168.1.253:39899')) {
            Reset-Fixture
            Assert-Failed (Invoke-PhoneControllerAction (New-NativeCommand -Unit $unit))
            Assert-Equal $script:calls.Count 0 'Invalid target cannot query or act through ADB.'
        }
    }
    Test-Case 'Reject unknown action, malformed command ID and arbitrary top-level overrides' {
        foreach ($type in @('phone-back;reboot','open-website','phone-return-termux')) {
            Reset-Fixture
            Assert-Failed (Invoke-PhoneControllerAction (New-NativeCommand -Type $type))
            Assert-Equal $script:calls.Count 0 'Unknown action cannot reach ADB.'
        }
        foreach ($field in @('cmd','command','url','serial','component','flags','settings','endpoint','operation','id')) {
            Reset-Fixture; $command=New-NativeCommand
            $command | Add-Member -NotePropertyName $field -NotePropertyValue '../untrusted' -Force
            Assert-Failed (Invoke-PhoneControllerAction $command)
            Assert-Equal $script:calls.Count 0 'Arbitrary command fields cannot reach ADB.'
        }
    }
    Test-Case 'Back payload is exactly an empty object and website payload exactly one URL' {
        foreach ($payload in @($null,'',@(),[pscustomobject]@{keycode=4},[pscustomobject]@{url='https://curtbrag.com/'})) {
            Reset-Fixture; Assert-Failed (Invoke-PhoneControllerAction (New-NativeCommand -Payload $payload))
            Assert-Equal $script:calls.Count 0 'Invalid Back payload stops before ADB.'
        }
        foreach ($payload in @([pscustomobject]@{},[pscustomobject]@{url=12},[pscustomobject]@{url='https://curtbrag.com/';cmd='echo changed'})) {
            Reset-Fixture; Assert-Failed (Invoke-PhoneControllerAction (New-NativeCommand -Type 'phone-open-website' -Payload $payload))
            Assert-Equal $script:calls.Count 0 'Invalid website payload stops before ADB.'
        }
    }
    Test-Case 'Public HTTPS validation rejects credentials, local IPs, reserved names and controls' {
        foreach ($url in @('http://curtbrag.com/','javascript:alert(1)','https://u:p@curtbrag.com/','https://curtbrag.com:8443/','https://127.0.0.1/','https://[::1]/','https://localhost/','https://box.local/','https://box.home/','https://site.example/','https://1.2/','https://123.456/','https://curtbrag.com./','https://curtbrag.com/a b',"https://curtbrag.com/a`nignored",'https://curtbrag.com\@bad.invalid/',('https://curtbrag.com/' + 'a'*2048))) {
            Reset-Fixture
            Assert-Failed (Invoke-PhoneControllerAction (New-NativeCommand -Type 'phone-open-website' -Payload ([pscustomobject]@{url=$url})))
            Assert-Equal $script:calls.Count 0 'Invalid URL cannot read ADB inventory.'
        }
    }
    Test-Case 'URL shell construction keeps metacharacters inside one exact data argument' {
        $url = 'https://curtbrag.com/a''b?one=$(id)&two=;echo&three=`cmd`#tail'
        $shell = Get-FixedPhoneControllerShell 'open-website' $url
        $python = Get-Command python -ErrorAction Stop
        $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$python.Source;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
        $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
        [void]$start.ArgumentList.Add('-c');[void]$start.ArgumentList.Add('import json,shlex,sys;print(json.dumps(shlex.split(sys.stdin.read())))')
        $process=[Diagnostics.Process]::new();$process.StartInfo=$start
        try {
            [void]$process.Start();$process.StandardInput.Write($shell);$process.StandardInput.Close()
            $output=$process.StandardOutput.ReadToEnd();$errorText=$process.StandardError.ReadToEnd()
            if(-not $process.WaitForExit(5000)){ $process.Kill();throw 'Local argument parser timed out' }
            Assert-Equal $process.ExitCode 0 'Local argument parser must finish.'
            $argv=@($output | ConvertFrom-Json)
            Assert-Equal $argv.Count 11 'The fixed launch has one URL argument.'
            Assert-Equal $argv[-1] $url 'Shell quoting must round-trip every URL character.'
            Assert-Equal $argv[-2] '-d' 'URL remains data for the fixed data flag.'
            Assert-Equal $argv[0] '/system/bin/am' 'Only the fixed opener is executable.'
        } finally { $process.Dispose() }
        Assert-Equal (Get-FixedPhoneControllerShell 'back') '/system/bin/input keyevent 4' 'Back has a fixed key only.'
        Assert-Throws {Get-FixedPhoneControllerShell 'back' 'https://curtbrag.com/'} 'Back cannot carry URL or arbitrary argument.'
    }
    Test-Case 'Unavailable and unauthorized transports never receive input or a connection attempt' {
        foreach ($devices in @('',"192.168.1.253:39899`tunauthorized","192.168.1.253:39899`toffline","192.168.1.191:42841`tdevice")) {
            Reset-Fixture $devices
            $report=Invoke-PhoneControllerAction (New-NativeCommand)
            Assert-Failed $report
            Assert-Equal (($script:calls.Operation)-join ',') 'devices' 'Only existing inventory may be read.'
        }
    }
    Test-Case 'Controller environment overrides reject before querying ADB' {
        Reset-Fixture; $script:override=$true
        Assert-Failed (Invoke-PhoneControllerAction (New-NativeCommand))
        Assert-Equal $script:calls.Count 0 'Overrides cannot choose another identity or server.'
    }
    Test-Case 'Each canonical phone accepts only its authorized exact transport' {
        foreach($number in @(173,174,176,177,191,195,253,254)) {
            Reset-Fixture "192.168.1.${number}:39899`tdevice"
            $report=Invoke-PhoneControllerAction (New-NativeCommand -Unit "phone$number")
            Assert-Equal $report.state 'back-requested' 'Authorized fixed Back request accepted.'
            Assert-True $report.request_accepted 'Native input command exit was accepted.'
            Assert-Equal $report.controller_state 'connected' 'Only existing authorized transport is used.'
            Assert-True (-not $report.foreground_app_verified -and -not $report.visible_screen_verified) 'Input success cannot claim screen effect.'
            Assert-Equal (($script:calls.Operation)-join ',') 'devices,back' 'Only one Back input request.'
            Assert-Equal $script:calls[1].Transport "192.168.1.${number}:39899" 'Only selected phone is targeted.'
        }
    }
    Test-Case 'Website receipt requires Status ok and keeps exact validated URL' {
        Reset-Fixture; $url='https://curtbrag.com/gallery/?view=a&item=2#detail'
        $report=Invoke-PhoneControllerAction (New-NativeCommand -Type 'phone-open-website' -Payload ([pscustomobject]@{url=$url}))
        Assert-Equal $report.state 'launch-requested' 'System accepted one launch request.'
        Assert-Equal $report.url $url 'Receipt retains requested URL.'
        Assert-Equal (($script:calls.Operation)-join ',') 'devices,open-website' 'No visibility claims or repeated launch.'
        Assert-Equal $script:calls[1].Url $url 'Only a URL is passed to the fixed shell builder.'
        Assert-True (-not $report.foreground_app_verified -and -not $report.visible_screen_verified) 'Website rendering remains unverified.'
    }
    Test-Case 'Zero-exit rejected or incomplete Android launch output remains failed' {
        foreach($output in @('','Starting: Intent','Status: timeout',"Status: ok`nError: Activity not started",'START_ABORTED','Permission Denial: details',"Status: ok`nStatus: timeout")) {
            Reset-Fixture; $script:replies['open-website']=[pscustomobject]@{ExitCode=0;Output=$output;ErrorOutput=''}
            Assert-Failed (Invoke-PhoneControllerAction (New-NativeCommand -Type 'phone-open-website' -Payload ([pscustomobject]@{url='https://curtbrag.com/'})))
            Assert-Equal @($script:calls | Where-Object Operation -CEQ 'open-website').Count 1 'Failed launch never retries.'
        }
    }
    Test-Case 'Nonzero, denied or unexpected Back output fails without disclosing raw device text' {
        foreach($reply in @([pscustomobject]@{ExitCode=1;Output='';ErrorOutput='private failure'},[pscustomobject]@{ExitCode=0;Output='Error: private';ErrorOutput=''},[pscustomobject]@{ExitCode=0;Output='unexpected';ErrorOutput=''})) {
            Reset-Fixture;$script:replies.back=$reply
            $report=Invoke-PhoneControllerAction (New-NativeCommand)
            Assert-Failed $report
            Assert-True (($report | ConvertTo-Json -Compress) -notmatch 'private') 'Raw UI and errors are not published.'
        }
    }
    Test-Case 'Ordinary URL words cannot be mistaken for Android error lines' {
        Reset-Fixture;$url='https://curtbrag.com/exception/abort?reason=permission'
        $script:replies['open-website']=[pscustomobject]@{ExitCode=0;Output="Starting: Intent { dat=$url }`nStatus: ok`nComplete";ErrorOutput=''}
        $report=Invoke-PhoneControllerAction (New-NativeCommand -Type 'phone-open-website' -Payload ([pscustomobject]@{url=$url}))
        Assert-Equal $report.state 'launch-requested' 'Only actual Android diagnostic lines can reject the receipt.'
    }
    Test-Case 'Lost completion acknowledgement reuses stored receipt without another Back' {
        Reset-Fixture;$command=New-NativeCommand
        $first=Invoke-PhoneControllerAction $command;$second=Invoke-PhoneControllerAction $command
        Assert-Equal $first.state 'back-requested' 'First request is accepted.'
        Assert-Equal $second.state 'back-requested' 'Completed receipt is reused.'
        Assert-Equal @($script:calls | Where-Object Operation -CEQ 'back').Count 1 'Duplicate command sends no additional Back.'
    }
    Test-Case 'An interrupted durable intent never replays input after restart' {
        Reset-Fixture;$command=New-NativeCommand;$request=Get-PhoneControllerActionRequest $command
        $path=Get-PhoneNativeCommandPath $request.Id;$digest=Get-PhoneNativeRequestDigest $request
        Write-PhoneNativeRecord $path ([ordered]@{version=1;request_digest=$digest;report=$null}) $true
        $report=Invoke-PhoneControllerAction $command
        Assert-Failed $report;Assert-Equal $report.controller_state 'unconfirmed' 'Incomplete prior execution remains unconfirmed.'
        Assert-Equal $script:calls.Count 0 'No inventory or input is sent again.'
    }
    Test-Case 'Failed authorization receipt is not re-executed if a device later authorizes' {
        Reset-Fixture '';$command=New-NativeCommand
        Assert-Failed (Invoke-PhoneControllerAction $command)
        $script:replies.devices="192.168.1.253:39899`tdevice"
        Assert-Failed (Invoke-PhoneControllerAction $command)
        Assert-Equal (($script:calls.Operation)-join ',') 'devices' 'A new explicit command is required after authority changes.'
    }
    Test-Case 'Reusing command ID with a different URL never sends the second request' {
        Reset-Fixture
        $command=New-NativeCommand -Type 'phone-open-website' -Payload ([pscustomobject]@{url='https://curtbrag.com/'})
        $null=Invoke-PhoneControllerAction $command;$command.payload.url='https://curtbrag.com/gallery/'
        Assert-Failed (Invoke-PhoneControllerAction $command)
        Assert-Equal @($script:calls | Where-Object Operation -CEQ 'open-website').Count 1 'Conflicting replay cannot navigate elsewhere.'
    }
    Test-Case 'Local intent store failure keeps the queued website URL and remains API-completable' {
        Reset-Fixture;$url='https://curtbrag.com/gallery/?item=2'
        [IO.File]::WriteAllText((Join-Path $script:base 'phone-native-command-once'),'A directory cannot replace this fixture file')
        $report=Invoke-PhoneControllerAction (New-NativeCommand -Type 'phone-open-website' -Payload ([pscustomobject]@{url=$url}))
        Assert-Failed $report
        Assert-Equal $report.url $url 'Even local-store failure retains the exact queued URL for API matching.'
        Assert-Equal $report.kind 'phone-controller-action' 'Completion keeps the typed report contract.'
        Assert-Equal $script:calls.Count 0 'A missing durable store prevents every controller request.'
    }
    Test-Case 'An unreadable prior receipt fails without another phone request' {
        Reset-Fixture;$command=New-NativeCommand;$path=Get-PhoneNativeCommandPath $command.id
        [IO.File]::WriteAllText($path,'not valid JSON')
        Assert-Failed (Invoke-PhoneControllerAction $command)
        Assert-Equal $script:calls.Count 0 'Invalid saved evidence cannot authorize re-execution.'
    }
    Test-Case 'Full receipt store refuses new input instead of forgetting an old command' {
        Reset-Fixture
        function Get-ChildItem { param([string]$LiteralPath,[switch]$File,[string]$Filter) 1..4096 | ForEach-Object { [pscustomobject]@{Name=('fixture-' + $_ + '.json')} } }
        $report=Invoke-PhoneControllerAction (New-NativeCommand)
        Assert-Failed $report
        Assert-True ($report.error -match 'store is full') 'Capacity failure is explicit.'
        Assert-Equal $script:calls.Count 0 'Capacity cannot cause evictions or input.'
    }
    Test-Case 'Losing the final local receipt after input leaves intent and suppresses replay' {
        Reset-Fixture;$command=New-NativeCommand
        $originalWriter=(Get-Item Function:Write-PhoneNativeRecord).ScriptBlock
        function Write-PhoneNativeRecord([string]$Path,$Record,[bool]$CreateOnly) {
            if (-not $CreateOnly) { throw 'fixture completion write failed' }
            & $originalWriter $Path $Record $CreateOnly
        }
        try {
            $first=Invoke-PhoneControllerAction $command;Assert-Failed $first
            Assert-Equal $first.controller_state 'unconfirmed' 'Loss of local completion remains unconfirmed.'
            Assert-Failed (Invoke-PhoneControllerAction $command)
            Assert-Equal @($script:calls | Where-Object Operation -CEQ 'back').Count 1 'Saved intent prevents second input after save failure.'
        } finally { Set-Item Function:Write-PhoneNativeRecord -Value $originalWriter }
    }
    Test-Case 'API completion retry posts the cached receipt without replaying phone input' {
        Reset-Fixture;$script:apiCommand=New-NativeCommand;$script:posted=New-Object Collections.Generic.List[object]
        function Invoke-ApiGet { return [pscustomobject]@{queue=@($script:apiCommand)} }
        function Invoke-ApiPost([string]$Action,$Body) { $script:posted.Add([pscustomobject]@{Action=$Action;Body=$Body});return $null }
        Assert-True (Process-Command) 'First native command consumed.'
        Assert-True (Process-Command) 'Completion can be reported again.'
        Assert-Equal $script:posted.Count 2 'Completion is retried independently of input.'
        Assert-Equal @($script:calls | Where-Object Operation -CEQ 'back').Count 1 'Back runs only once across completion retries.'
        Assert-Equal $script:posted[0].Body.status 'completed' 'Accepted request is completed, without claiming physical proof.'
    }
    Write-Output "PASS $script:cases native-controller cases; no real controller requests were made."
} finally {
    # Delete only the verified, uniquely named directory created by this test.
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if ($resolved.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^curt-native-controller-tests-[a-f0-9]{32}$' -and [IO.Directory]::Exists($resolved)) {
        [IO.Directory]::Delete($resolved,$true)
    }
}
