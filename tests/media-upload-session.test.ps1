$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../scripts/curt-hybrid-workload-agent.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Agent syntax invalid'}
foreach($name in @('Invoke-ClusterMediaRequest','Upload-Reel','Upload-Episode')) {
 $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 . ([scriptblock]::Create($definition.Extent.Text))
}
$script:calls=[Collections.Generic.List[object]]::new()
$script:fail=$false
function Invoke-CurtClusterRequest($Password,[hashtable]$Request) {
 if($Password -cne 'fixture'){throw 'Wrong session credential'}
 $script:calls.Add($Request)
 if($script:fail){throw 'Response lost'}
 if($Request.Uri -match 'finalize=1'){return @{ok=$true;bytes=$script:fileLength}}
 if($Request.Body){return @{ok=$true;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$Request.Body)).ToLowerInvariant()}}
 return @{ok=$true}
}
$path=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()+'.mp4')
try {
 $bytes=[byte[]]::new(2MB+17);$bytes[4]=102;$bytes[5]=116;$bytes[6]=121;$bytes[7]=112;$bytes[-1]=123
 [IO.File]::WriteAllBytes($path,$bytes);$script:fileLength=$bytes.Length
 $config=@{password='fixture';swarm_url='https://curtbrag.com/api/cluster'}
 $result=Upload-Episode $config 'fixture-job' 'master' $path
 if(-not $result.ok -or $script:calls.Count -ne 3){throw 'Chunked upload/finalization failed'}
 if($script:calls[0].Body.Length -ne 2MB -or $script:calls[1].Body.Length -ne 17 -or $script:calls[1].Body[-1] -ne 123){throw 'Binary payload changed'}
 $script:calls.Clear();$script:fail=$true
 try {Upload-Episode $config 'fixture-job' 'short' $path;throw 'Expected upload failure'} catch {if($_.Exception.Message -ne 'Response lost'){throw}}
 if($script:calls.Count -ne 1){throw 'Failed upload retried or finalized'}
 $script:fail=$false;$script:calls.Clear()
 $null=Upload-Reel $config 'fixture-reel' $path
 if($script:calls.Count -ne 1 -or $script:calls[0].InFile -ne $path){throw 'Reel did not use authenticated upload'}
 Write-Output 'PASS: authenticated binary chunks, finalization, reel upload and no replay after failure'
} finally {Remove-Item -LiteralPath $path -Force}
