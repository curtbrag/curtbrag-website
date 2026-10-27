# Extract only public function ASTs and one polling body. Never source startup,
# read installed configuration/policy/credentials, or contact a device/API.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../scripts/curt-cluster-bridge-windows.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Bridge source does not parse.' }
$names=@('Get-ApiUri','Invoke-ApiGet','Invoke-ApiPost','Get-SwarmNodes','Start-Phone','Apply-Desired','Get-HeldBridgeCommandIds','Select-BridgeControlCommand','Process-Command')
$functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -In $names)
if($functions.Count -ne $names.Count){throw 'Missing isolated bridge policy function.'}
foreach($function in $functions){. ([scriptblock]::Create($function.Extent.Text))}
$realGet=(Get-Item Function:Invoke-ApiGet).ScriptBlock
$realPost=(Get-Item Function:Invoke-ApiPost).ScriptBlock
$realApply=(Get-Item Function:Apply-Desired).ScriptBlock
$script:cases=0
$script:legacyHold='112fe487d5ea83a1f265a74a72486ad6'
$testRoot=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('curt-bridge-policy-tests-'+[Guid]::NewGuid().ToString('N'))))
$tempParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
if(-not $testRoot.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($testRoot) -notmatch '^curt-bridge-policy-tests-[a-f0-9]{32}$'){throw 'Temporary fixture path did not verify.'}
$null=[IO.Directory]::CreateDirectory($testRoot)
function Assert-True($Value,[string]$Message){if(-not $Value){throw $Message}}
function Assert-Equal($Actual,$Expected,[string]$Message){if($Actual -cne $Expected){throw "$Message expected=$Expected actual=$Actual"}}
function Assert-Throws([scriptblock]$Body,[string]$Message){$threw=$false;try{& $Body|Out-Null}catch{$threw=$true};Assert-True $threw $Message}
function Test-Case([string]$Name,[scriptblock]$Body){try{& $Body;$script:cases++;Write-Output "PASS $Name"}catch{throw "FAIL ${Name}: $($_.Exception.Message)"}}
function New-QueueCommand([string]$Id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',[string]$Type='phone-back'){
    return [pscustomobject]@{id=$Id;target='phone253';type=$Type;payload=[pscustomobject]@{}}
}
function Reset-Fixture{
    $script:base=Join-Path $testRoot ([Guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($script:base)
    $script:MonitorOnly=$false;$script:NoMining=$false
    $script:queue=@();$script:apiReads=New-Object Collections.Generic.List[string]
    $script:posts=New-Object Collections.Generic.List[object]
    $script:nativeCalls=0;$script:deviceReads=0;$script:remoteCalls=0;$script:pushCalls=0;$script:processCalls=0;$script:applyCalls=0
    $script:targets=@([pscustomobject]@{Hostname='phone253';IP='192.168.1.253'})
}
function Invoke-ApiGet([string]$Action){$script:apiReads.Add($Action);return [pscustomobject]@{queue=$script:queue}}
function Invoke-ApiPost([string]$Action,$Body){$script:posts.Add([pscustomobject]@{Action=$Action;Body=$Body});return [pscustomobject]@{ok=$true}}
function Invoke-RestMethod{throw 'Direct HTTP must not bypass the site-session helper.'}
function Invoke-CurtClusterRequest([string]$Password,$Request){$script:sessionRequests.Add($Request);return $script:sessionReply}
function Get-DeviceForHost{$script:deviceReads++;throw 'A blocked mining path must not read device state.'}
function Get-PhoneState{$script:deviceReads++;return $null}
function Invoke-Phone{$script:remoteCalls++;throw 'Tests never send SSH commands.'}
function Push-PhoneState{$script:pushCalls++}
function Resolve-Targets{return $script:targets}
function Write-Log{param($Message)}
function Start-Sleep{param($Seconds,$Milliseconds)}
function Invoke-PhoneControllerAction($Command){
    $script:nativeCalls++
    return [pscustomobject]@{kind='phone-controller-action';unit=$Command.target;action='back';state='back-requested';request_accepted=$true;foreground_app_verified=$false;visible_screen_verified=$false;controller_state='connected';error=$null}
}
function Invoke-PhoneControllerReturn{throw 'No Return request is expected in this test.'}

try{
    Test-Case 'Published bridge accepts MonitorOnly and NoMining switches without running startup'{
        $parameters=@($ast.ParamBlock.Parameters | ForEach-Object {$_.Name.VariablePath.UserPath})
        Assert-True ('MonitorOnly' -cin $parameters -and 'NoMining' -cin $parameters) 'Both installed task arguments must remain supported.'
        foreach($name in @('MonitorOnly','NoMining')){
            $parameter=$ast.ParamBlock.Parameters | Where-Object {$_.Name.VariablePath.UserPath -ceq $name}
            Assert-True ($parameter.StaticType -eq [System.Management.Automation.SwitchParameter]) 'Mode arguments remain switches.'
        }
    }
    Test-Case 'Site-session helper is retained and every API helper routes through it'{
        Assert-True ($ast.Extent.Text.Contains('. (Join-Path $PSScriptRoot ''cluster-site-session.ps1'')')) 'Bridge must load the reviewed site-session code.'
        $script:sessionRequests=New-Object Collections.Generic.List[object]
        $script:sessionReply=[pscustomobject]@{nodes=@(1,2,3,4,5,6,7,8)}
        $api='https://curtbrag.com/.netlify/functions/cluster-api';$swarmApi='https://curtbrag.com/api/cluster';$password='fixture';$headers=@{Authorization='Bearer fixture'};$phones=@(1,2,3,4,5,6,7,8)
        $null=& $realGet 'devices'
        $null=& $realPost 'bridge-heartbeat' @{fixture=$true}
        $nodes=@(Get-SwarmNodes)
        Assert-Equal $script:sessionRequests.Count 3 'GET, POST and swarm status all use the session wrapper.'
        Assert-Equal $script:sessionRequests[0].Method 'Get' 'Read keeps method.'
        Assert-Equal $script:sessionRequests[1].Method 'Post' 'Write keeps method.'
        Assert-Equal $script:sessionRequests[2].Method 'Get' 'Swarm status uses authenticated session read.'
        Assert-Equal $nodes.Count 8 'Swarm roster validation remains intact.'
    }
    Test-Case 'Permanent historical reconcile hold applies even with no policy file'{
        Reset-Fixture;$held=New-QueueCommand $script:legacyHold 'reconcile';$script:queue=@($held)
        Assert-True (-not (Process-Command)) 'Held-only queue cannot be consumed.'
        Assert-Equal $script:posts.Count 0 'Never complete, remove or drain the held record.'
        Assert-Equal $script:nativeCalls 0 'No native input for a held command.'
        Assert-Equal $script:deviceReads 0 'No desired reconciliation or device read.'
        Assert-Equal $script:queue[0].id $script:legacyHold 'Held record remains in the fixture queue.'
    }
    Test-Case 'Configured holds and the permanent hold are skipped while a new typed action can proceed'{
        Reset-Fixture;$other='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        [IO.File]::WriteAllText((Join-Path $script:base 'control-restore-policy.json'),(@{held_bridge_command_ids=@($other)}|ConvertTo-Json))
        $script:queue=@((New-QueueCommand $script:legacyHold 'reconcile'),(New-QueueCommand $other 'reconcile'),(New-QueueCommand))
        $before=$script:queue|ConvertTo-Json -Compress
        Assert-True (Process-Command) 'Fresh unheld typed action remains available.'
        Assert-Equal $script:nativeCalls 1 'Only new native action is selected.'
        Assert-Equal $script:posts.Count 1 'Only its completion is sent.'
        Assert-Equal $script:posts[0].Body.id 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'Held IDs cannot be completed.'
        Assert-Equal ($script:queue|ConvertTo-Json -Compress) $before 'Selection never mutates any queue records.'
    }
    Test-Case 'The permanent held ID is protected by the selector independently of policy loading'{
        $held=New-QueueCommand $script:legacyHold 'reconcile'
        Assert-True ($null -eq (Select-BridgeControlCommand @($held) @())) 'Empty supplied holds cannot resume the legacy request.'
    }
    Test-Case 'Unreadable or malformed hold policy fails closed before any command input or completion'{
        foreach($contents in @('not JSON','{}','{"held_bridge_command_ids":["bad/id"]}')){
            Reset-Fixture;$script:queue=@((New-QueueCommand))
            [IO.File]::WriteAllText((Join-Path $script:base 'control-restore-policy.json'),$contents)
            Assert-Throws {Process-Command} 'A broken policy must not silently discard holds.'
            Assert-Equal $script:posts.Count 0 'No queued item is drained when holds are unknown.'
            Assert-Equal $script:nativeCalls 0 'Unknown hold policy cannot send input.'
        }
    }
    Test-Case 'MonitorOnly prevents direct Process-Command calls from even reading the command queue'{
        Reset-Fixture;$script:MonitorOnly=$true;$script:queue=@((New-QueueCommand))
        Assert-True (-not (Process-Command)) 'Monitoring mode cannot consume commands.'
        Assert-Equal $script:apiReads.Count 0 'Monitoring mode does not claim or inspect queued requests.'
        Assert-Equal $script:posts.Count 0 'Monitoring mode does not complete commands.'
        Assert-Equal $script:nativeCalls 0 'Monitoring mode sends no phone input.'
    }
    Test-Case 'NoMining and MonitorOnly reject direct miner starts before any device or SSH read'{
        foreach($mode in @('NoMining','MonitorOnly')){
            Reset-Fixture;Set-Variable -Name $mode -Scope Script -Value $true
            foreach($force in @($false,$true)){
                $result=Start-Phone ([pscustomobject]@{Hostname='phone253';IP='192.168.1.253'}) $force
                Assert-Equal $result.Exit 2 'Both ordinary and forced miner starts are denied.'
            }
            $null=Apply-Desired ([pscustomobject]@{Hostname='phone253';IP='192.168.1.253'}) $true
            Assert-Equal $script:deviceReads 0 'Disabled desired state returns before private device/API lookup.'
            Assert-Equal $script:remoteCalls 0 'No mining or SSH mutation occurs.'
        }
    }
    Test-Case 'NoMining reports legacy miner and reconciliation commands as failed rather than completed'{
        foreach($type in @('mining-start','fresh-connect','start','restart','reconcile')){
            Reset-Fixture;$script:NoMining=$true;$script:queue=@((New-QueueCommand -Type $type))
            Assert-True (Process-Command) 'Blocked explicit request gets a failure result.'
            Assert-Equal $script:posts.Count 1 'Only failure completion is written.'
            Assert-Equal $script:posts[0].Body.status 'failed' 'Policy refusal cannot be marked successful.'
            Assert-Equal $script:deviceReads 0 'Reconcile cannot read or apply desired state.'
            Assert-Equal $script:remoteCalls 0 'No remote start is sent.'
        }
    }
    Test-Case 'NoMining preserves typed dashboard controls while the permanent reconcile stays held'{
        Reset-Fixture;$script:NoMining=$true;$script:queue=@((New-QueueCommand $script:legacyHold 'reconcile'),(New-QueueCommand))
        Assert-True (Process-Command) 'An unrelated explicit native action can proceed in NoMining mode.'
        Assert-Equal $script:nativeCalls 1 'Only new native action is invoked.'
        Assert-Equal $script:posts[0].Body.status 'completed' 'Typed receipt remains independently reported.'
        Assert-Equal $script:posts[0].Body.id 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'Held reconciliation remains untouched.'
    }
    Test-Case 'Unsupported commands and missing targets explicitly report failed completion'{
        Reset-Fixture;$script:queue=@((New-QueueCommand -Type 'unknown-operation'))
        $null=Process-Command
        Assert-Equal $script:posts[0].Body.status 'failed' 'Unknown operation cannot report completion success.'
        Reset-Fixture;$script:queue=@((New-QueueCommand -Type 'mining-status'));$script:targets=@()
        $null=Process-Command
        Assert-Equal $script:posts[0].Body.status 'failed' 'No matching target cannot report success.'
    }
    Test-Case 'Startup registry reconciliation is gated under either protected mode'{
        $startup=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.IfStatementAst] -and $_.Extent.Text -match 'Reconcile-Registry'})
        Assert-Equal $startup.Count 1 'Registry startup has one explicit conditional gate.'
        foreach($modes in @(@($true,$false),@($false,$true),@($true,$true),@($false,$false))){
            $MonitorOnly=$modes[0];$NoMining=$modes[1];$script:reconciles=0
            function Reconcile-Registry{$script:reconciles++}
            . ([scriptblock]::Create($startup[0].Extent.Text))
            Assert-Equal $script:reconciles $(if(-not $MonitorOnly -and -not $NoMining){1}else{0}) 'Protected startup cannot alter registry/desired state.'
        }
    }
    Test-Case 'One actual polling body in MonitorOnly keeps heartbeat but skips command and desired-state execution'{
        Reset-Fixture;$script:MonitorOnly=$true
        $loops=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.WhileStatementAst]})
        Assert-Equal $loops.Count 1 'One top-level polling loop is expected.'
        function Process-Command{$script:processCalls++;throw 'MonitorOnly must never process commands.'}
        function Apply-Desired{$script:applyCalls++;throw 'MonitorOnly must never reconcile desired state.'}
        function Get-FleetConnections{return [pscustomobject]@{devices=@()}}
        function Get-PhoneControllerAvailability{return [pscustomobject]@{schema=1;devices=@()}}
        $phones=@([pscustomobject]@{Hostname='phone253';IP='192.168.1.253'})
        $lastFleetCheck=[DateTime]::MinValue;$lastHeartbeat=[DateTime]::MinValue;$lastRefresh=[DateTime]::MinValue
        $body=$loops[0].Body.Extent.Text
        . ([scriptblock]::Create($body.Substring(1,$body.Length-2)))
        Assert-Equal $script:processCalls 0 'The production loop does not process commands.'
        Assert-Equal $script:applyCalls 0 'The production loop does not apply desired state.'
        Assert-Equal $script:nativeCalls 0 'The production loop sends no input.'
        Assert-Equal $script:pushCalls 1 'Read-only state monitoring remains active.'
        Assert-Equal $script:posts.Count 1 'A heartbeat remains available.'
        Assert-True ($script:posts[0].Body.summary -match 'monitoring only') 'Heartbeat discloses the actual protected mode.'
    }
    Write-Output "PASS $script:cases bridge runtime-policy cases; no installed policy, credentials, API or devices were accessed."
}finally{
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if($resolved.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^curt-bridge-policy-tests-[a-f0-9]{32}$' -and [IO.Directory]::Exists($resolved)){[IO.Directory]::Delete($resolved,$true)}
}
