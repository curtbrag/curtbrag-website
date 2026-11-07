$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../scripts/curt-hybrid-workload-agent.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Agent syntax invalid'}
$function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-ComfyWorkflow'},$true)
. ([scriptblock]::Create($function.Extent.Text))
$script:calls=0;$script:mode='success';$script:posts=0
function Start-Sleep {param($Milliseconds)}
function Get-Content {param($LiteralPath,[switch]$Raw) '{"prompt":{}}'}
function Invoke-RestMethod {
 param($Uri,$Method,$ContentType,$Body,$TimeoutSec)
 if($Method -eq 'Post'){$script:posts++;return @{prompt_id='fixture-123'}}
 if($Uri -ne 'http://127.0.0.1:8188/history/fixture-123'){throw 'Unexpected history destination'}
 $script:calls++
 if($script:mode -eq 'error'){return @{'fixture-123'=@{status=@{status_str='error';completed=$false}}}}
 if($script:mode -eq 'lost'){throw 'History connection lost'}
 if($script:calls -eq 1){return @{}}
 return @{'fixture-123'=@{status=@{status_str='success';completed=$true};outputs=@{images=@('result.png')}}}
}
$result=Invoke-ComfyWorkflow fixture.json 'http://127.0.0.1:8188/prompt'
$body=$result.stdout|ConvertFrom-Json
if($script:calls -ne 2 -or $body.status -ne 'completed' -or $body.outputs.images[0] -ne 'result.png'){throw 'Queue acknowledgement treated as final output'}
foreach($mode in @('error','lost')){
 $script:mode=$mode;$before=$script:posts;$failed=$false
 try {Invoke-ComfyWorkflow fixture.json 'http://127.0.0.1:8188/prompt'|Out-Null}catch{$failed=$true}
 if(-not $failed -or $script:posts -ne $before+1){throw 'Failed execution was treated as success or resubmitted'}
}
$before=$script:posts;$failed=$false
try {Invoke-ComfyWorkflow fixture.json 'https://example.com/prompt'|Out-Null}catch{$failed=$true}
if(-not $failed -or $script:posts -ne $before){throw 'Nonlocal endpoint was contacted'}
'PASS: pending history is polled, outputs are returned only after success, and failures never resubmit'
