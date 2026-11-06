param(
 [string]$Root=(Join-Path $env:LOCALAPPDATA 'CurtCompute'),
 [ValidateSet('tiny.en','base.en','small.en')][string]$Model='small.en'
)
$ErrorActionPreference='Stop'
$python=(Get-Command python.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $Root|Out-Null
$environment=Join-Path $Root 'transcription-venv'
if(-not (Test-Path (Join-Path $environment 'Scripts\python.exe'))){
 & $python -m venv $environment
 if($LASTEXITCODE){throw 'Transcription environment creation failed'}
}
$engine=Join-Path $environment 'Scripts\python.exe'
& $engine -m pip install 'faster-whisper==1.2.1'
if($LASTEXITCODE){throw 'Transcription package installation failed'}
$cache=Join-Path $Root 'transcription-models'
& $engine -c 'import sys; from faster_whisper import WhisperModel; WhisperModel(sys.argv[1],device="cpu",compute_type="int8",download_root=sys.argv[2],cpu_threads=4)' $Model $cache
if($LASTEXITCODE){throw 'Transcription model preparation failed'}
$worker=Join-Path $PSScriptRoot 'cluster-transcribe.py'
if(-not (Test-Path -LiteralPath $worker)){throw 'cluster-transcribe.py must be next to this setup script'}
Copy-Item -LiteralPath $worker -Destination (Join-Path $Root 'transcribe.py') -Force
Write-Output "Local CPU transcription ready: $Model. Media jobs use the prepared model without downloading models during execution."
