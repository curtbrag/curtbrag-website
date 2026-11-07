param([string]$Root=(Join-Path $env:LOCALAPPDATA 'CurtCompute'))
$ErrorActionPreference='Stop'
$python=Join-Path $Root 'comfy-venv\Scripts\python.exe'
$server=Join-Path $Root 'ComfyUI\main.py'
if(-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $server)){
 throw 'Prepare the isolated ComfyUI environment first.'
}
Push-Location (Join-Path $Root 'ComfyUI')
try {
 & $python $server --listen 127.0.0.1 --port 8188 --disable-auto-launch --disable-all-custom-nodes --offline *> (Join-Path $Root 'comfy-service.log')
 exit $LASTEXITCODE
} finally {Pop-Location}
