param(
  [Parameter(Mandatory=$true)][string]$Node,
  [string]$ApiKey = $env:CLUSTER_API_KEY
)
$ErrorActionPreference='Stop'
$base=Join-Path $env:LOCALAPPDATA 'CurtCluster'
$agent=Join-Path $base 'cluster-job-agent.py'
$envFile=Join-Path $base 'job-agent.json'
$url='https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-job-agent.py'
New-Item -ItemType Directory -Force -Path $base | Out-Null
if(-not (Get-Command python -ErrorAction SilentlyContinue)){throw 'Python is required'}
Invoke-WebRequest -UseBasicParsing $url -OutFile $agent
if(-not $ApiKey){$secure=Read-Host 'CLUSTER_API_KEY' -AsSecureString;$ApiKey=[System.Net.NetworkCredential]::new('', $secure).Password}
@{node=$Node;api_key=$ApiKey;url='https://curtbrag.com/api/jobs'} | ConvertTo-Json | Set-Content -Encoding UTF8 $envFile
$launcher=Join-Path $base 'start-job-agent.ps1'
$launcherBody = @(
  '`$cfg=Get-Content ''' + $envFile + ''' -Raw | ConvertFrom-Json',
  '`$env:CLUSTER_NODE=`$cfg.node',
  '`$env:CLUSTER_API_KEY=`$cfg.api_key',
  '`$env:CLUSTER_JOBS_URL=`$cfg.url',
  'python ''' + $agent + ''' *>> ''' + (Join-Path $base 'job-agent.log') + ''''
) -join [Environment]::NewLine
$launcherBody | Set-Content -Encoding UTF8 $launcher
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"')
$trigger=New-ScheduledTaskTrigger -AtLogOn
$settings=New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName ('CurtClusterJobAgent-' + $Node) -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName ('CurtClusterJobAgent-' + $Node)
Write-Host ("ONLINE: " + $Node + " job agent scheduled and started.") -ForegroundColor Green
Write-Host ("Log: " + (Join-Path $base "job-agent.log"))
