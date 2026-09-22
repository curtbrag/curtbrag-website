#Requires -Version 7.0
param(
    [ValidateSet('Audit','Install','InstallTools','Run','Status','Stop')]
    [string]$Mode = 'Audit',
    [string]$DeviceId = 'RenderRig',
    [string]$SwarmUrl = 'https://curtbrag.com/api/cluster',
    [int]$PollSeconds = 10
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '3.2.0'
$Root = Join-Path $env:LOCALAPPDATA 'CurtCompute'
$AgentPath = Join-Path $Root 'curt-hybrid-workload-agent.ps1'
$ConfigPath = Join-Path $Root 'agent-config.json'
$LogPath = Join-Path $Root 'agent.log'
$TaskName = 'CurtHybridWorkloadAgent'

function Write-AgentLog([string]$Message) {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
    Write-Host $line
}

function Get-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $fallbacks = switch ($Name.ToLowerInvariant()) {
        'blender.exe' { @((Join-Path $env:ProgramFiles 'Blender Foundation\Blender *\blender.exe')) }
        'ffmpeg.exe' {
            @(
                (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'),
                (Join-Path $env:ProgramFiles 'WinGet\Links\ffmpeg.exe')
            )
        }
        default { @() }
    }
    foreach ($pattern in $fallbacks) {
        $match = Get-Item -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
        if ($match) { return $match.FullName }
    }
    return $null
}

function Install-ProductionTools {
    $winget = Get-CommandPath 'winget.exe'
    if (-not $winget) { throw 'WinGet is required. Install or update App Installer from Microsoft Store, then retry.' }

    $packages = @(
        [pscustomobject]@{ Id='BlenderFoundation.Blender'; Name='Blender' },
        [pscustomobject]@{ Id='Gyan.FFmpeg'; Name='FFmpeg' }
    )

    foreach ($package in $packages) {
        Write-Host "Installing $($package.Name)..." -ForegroundColor Cyan
        & $winget install --id $package.Id --exact --source winget --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw "$($package.Name) installation failed with exit code $LASTEXITCODE." }
    }

    $blender = Get-CommandPath 'blender.exe'
    $ffmpeg = Get-CommandPath 'ffmpeg.exe'
    if (-not $blender -or -not $ffmpeg) { throw 'Installation finished, but one or more tools could not be located. Sign out and back in, then run -Mode Status.' }

    Write-Host 'Production tools installed and verified.' -ForegroundColor Green
    [ordered]@{
        blender = (& $blender --version 2>$null | Select-Object -First 1)
        blender_path = $blender
        ffmpeg = (& $ffmpeg -version 2>$null | Select-Object -First 1)
        ffmpeg_path = $ffmpeg
        nvenc = [bool]((& $ffmpeg -hide_banner -encoders 2>$null | Select-String 'h264_nvenc'))
    } | ConvertTo-Json -Depth 4
}

function Get-GpuInfo {
    $nvidia = Get-CommandPath 'nvidia-smi.exe'
    if ($nvidia) {
        $rows = & $nvidia --query-gpu=index,name,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
        return @($rows | ForEach-Object {
            $p = $_ -split ',\s*'
            [ordered]@{ index=$p[0]; name=$p[1]; memory_mib=$p[2]; utilization_pct=$p[3]; temperature_c=$p[4]; watts=$p[5] }
        })
    }
    return @(Get-CimInstance Win32_VideoController | ForEach-Object {
        [ordered]@{ index=$null; name=$_.Name; memory_mib=[math]::Round($_.AdapterRAM / 1MB); utilization_pct=$null; temperature_c=$null; watts=$null }
    })
}

function Get-SaladState {
    $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Salad*' })
    $services = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*Salad*' -or $_.DisplayName -like '*Salad*' })
    [ordered]@{
        running = ($processes.Count -gt 0 -or @($services | Where-Object Status -eq 'Running').Count -gt 0)
        processes = @($processes | Select-Object -ExpandProperty ProcessName -Unique)
        services = @($services | ForEach-Object { [ordered]@{ name=$_.Name; status=[string]$_.Status } })
    }
}

function Get-Audit {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    [ordered]@{
        device_id = $DeviceId
        hostname = $env:COMPUTERNAME
        agent_version = $AgentVersion
        windows = $os.Caption
        cpu = $cpu.Name
        logical_processors = $cpu.NumberOfLogicalProcessors
        ram_gib = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
        free_gib = [math]::Round((Get-PSDrive -Name ($Root.Substring(0,1))).Free / 1GB, 1)
        gpu = @(Get-GpuInfo)
        tools = [ordered]@{
            blender = Get-CommandPath 'blender.exe'
            ffmpeg = Get-CommandPath 'ffmpeg.exe'
            python = Get-CommandPath 'python.exe'
            nvidia_smi = Get-CommandPath 'nvidia-smi.exe'
        }
        salad = Get-SaladState
        supported_jobs = @('status','gpu-status','salad-status','workstation-selftest','blender-render','ffmpeg-transcode','whisper-transcribe','comfyui-workflow')
    }
}

function Read-PlainDashboardPassword {
    $bridgeConfig = Join-Path $env:LOCALAPPDATA 'CurtCluster\bridge-config.json'
    if (-not (Test-Path -LiteralPath $bridgeConfig)) { throw "Existing cluster bridge config not found: $bridgeConfig" }
    $bridge = Get-Content -LiteralPath $bridgeConfig -Raw | ConvertFrom-Json
    if (-not $bridge.password_cipher) { throw 'Cluster bridge config has no encrypted dashboard password.' }
    $secure = ConvertTo-SecureString ([string]$bridge.password_cipher)
    return [System.Net.NetworkCredential]::new('', $secure).Password
}

function Get-Config {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Agent is not installed. Run: & `"$PSCommandPath`" -Mode Install" }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $secure = ConvertTo-SecureString ([string]$config.password_cipher)
    $config | Add-Member -NotePropertyName password -NotePropertyValue ([System.Net.NetworkCredential]::new('', $secure).Password) -Force
    return $config
}

function Invoke-Swarm([string]$Action, [string]$Method='GET', $Body=$null, $Config, [hashtable]$Query=@{}) {
    $headers = @{ Authorization="Bearer $($Config.password)"; 'Content-Type'='application/json' }
    if ($Query.ContainsKey('device_id') -and $Query.device_id) {
        $headers['X-Device-Id'] = [string]$Query.device_id
    }
    $queryParts = @("action=$([uri]::EscapeDataString($Action))", "_=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())")
    foreach ($entry in $Query.GetEnumerator()) {
        $queryParts += "$([uri]::EscapeDataString([string]$entry.Key))=$([uri]::EscapeDataString([string]$entry.Value))"
    }
    $uri = "$($Config.swarm_url)?$($queryParts -join '&')"
    $args = @{ Uri=$uri; Headers=$headers; Method=$Method; TimeoutSec=20 }
    if ($null -ne $Body) { $args.Body = ($Body | ConvertTo-Json -Depth 12 -Compress) }
    Invoke-RestMethod @args
}

function Suspend-Salad {
    $record = [ordered]@{ processes=@(); services=@() }
    foreach ($service in @(Get-Service -ErrorAction SilentlyContinue | Where-Object { ($_.Name -like '*Salad*' -or $_.DisplayName -like '*Salad*') -and $_.Status -eq 'Running' })) {
        $record.services += $service.Name
        Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
    }
    foreach ($process in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Salad*' })) {
        try { if ($process.Path) { $record.processes += $process.Path } } catch {}
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    return $record
}

function Resume-Salad($Record) {
    foreach ($service in @($Record.services)) { Start-Service -Name $service -ErrorAction SilentlyContinue }
    foreach ($path in @($Record.processes | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $path) { Start-Process -FilePath $path -ErrorAction SilentlyContinue }
    }
}

function Resolve-SafePath([string]$Path, [switch]$Output) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A file path is required.' }
    $full = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
    if (-not $Output -and -not (Test-Path -LiteralPath $full)) { throw "Input not found: $full" }
    if ($Output) {
        $parent = Split-Path -Parent $full
        if (-not $parent) { throw 'Output must include a directory.' }
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    return $full
}

function Parse-JobSpec([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return [pscustomobject]@{} }
    try { return $Text | ConvertFrom-Json }
    catch { throw 'Job settings must be JSON from the dashboard form.' }
}

function Invoke-External([string]$FilePath, [string[]]$Arguments) {
    $errFile = Join-Path $Root ('stderr-' + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        $stdout = (& $FilePath @Arguments 2> $errFile | Out-String).Trim()
        $exitCode = $LASTEXITCODE
        [ordered]@{
            exit_code = $exitCode
            stdout = $stdout
            stderr = if (Test-Path $errFile) { (Get-Content $errFile -Raw).Trim() } else { '' }
        }
    } finally { Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue }
}

function Invoke-WorkstationSelfTest {
    $blender = Get-CommandPath 'blender.exe'; if (-not $blender) { throw 'Blender is not installed or not on PATH.' }
    $ffmpeg = Get-CommandPath 'ffmpeg.exe'; if (-not $ffmpeg) { throw 'FFmpeg is not installed or not on PATH.' }
    $testRoot = Join-Path $Root 'selftest'
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    $png = Join-Path $testRoot 'blender-test.png'
    $video = Join-Path $testRoot 'nvenc-test.mp4'
    Remove-Item -LiteralPath $png,$video -Force -ErrorAction SilentlyContinue

    $pngJson = $png | ConvertTo-Json -Compress
    $scene = "import bpy; from mathutils import Vector; bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False); bpy.ops.mesh.primitive_cube_add(location=(0,0,1)); cube=bpy.context.object; cube.rotation_euler=(0.35,0.2,0.65); bpy.ops.mesh.primitive_plane_add(size=20, location=(0,0,0)); bpy.ops.object.light_add(type='AREA', location=(4,-4,6)); bpy.context.object.data.energy=1200; bpy.context.object.data.shape='DISK'; bpy.context.object.data.size=5; bpy.ops.object.camera_add(location=(5,-5,4)); cam=bpy.context.object; cam.rotation_euler=((Vector((0,0,1))-cam.location).to_track_quat('-Z','Y').to_euler()); bpy.context.scene.camera=cam; scene=bpy.context.scene; scene.render.engine='BLENDER_EEVEE_NEXT'; scene.render.resolution_x=640; scene.render.resolution_y=360; scene.render.resolution_percentage=100; scene.render.image_settings.file_format='PNG'; scene.render.filepath=$pngJson; bpy.ops.render.render(write_still=True)"
    $blenderResult = Invoke-External $blender @('--background','--factory-startup','--python-expr',$scene)
    if ($blenderResult.exit_code -ne 0 -or -not (Test-Path -LiteralPath $png)) {
        throw "Blender self-test failed: $($blenderResult.stderr)"
    }

    $ffmpegResult = Invoke-External $ffmpeg @('-y','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-t','3','-c:v','h264_nvenc','-preset','p4','-pix_fmt','yuv420p',$video)
    if ($ffmpegResult.exit_code -ne 0 -or -not (Test-Path -LiteralPath $video)) {
        throw "NVENC self-test failed: $($ffmpegResult.stderr)"
    }

    return [ordered]@{
        exit_code = 0
        stdout = ([ordered]@{
            status='PASS'
            blender_png=$png
            blender_bytes=(Get-Item -LiteralPath $png).Length
            nvenc_video=$video
            nvenc_bytes=(Get-Item -LiteralPath $video).Length
            gpu=(Get-GpuInfo)
        } | ConvertTo-Json -Depth 6 -Compress)
        stderr = ''
    }
}

function Invoke-Workload([string]$Type, [string]$Command) {
    $spec = Parse-JobSpec $Command
    switch ($Type) {
        'status' { return [ordered]@{ exit_code=0; stdout=(Get-Audit | ConvertTo-Json -Depth 8 -Compress); stderr='' } }
        'gpu-status' { return [ordered]@{ exit_code=0; stdout=(Get-GpuInfo | ConvertTo-Json -Depth 5 -Compress); stderr='' } }
        'salad-status' { return [ordered]@{ exit_code=0; stdout=(Get-SaladState | ConvertTo-Json -Depth 5 -Compress); stderr='' } }
        'workstation-selftest' { return Invoke-WorkstationSelfTest }
        'blender-render' {
            $exe = Get-CommandPath 'blender.exe'; if (-not $exe) { throw 'Blender is not installed or not on PATH.' }
            $input = Resolve-SafePath ([string]$spec.input); $output = Resolve-SafePath ([string]$spec.output) -Output
            $args = @('-b',$input,'-o',$output,'-E','BLENDER_EEVEE_NEXT','-a'); if ($spec.engine -eq 'cycles') { $args[5] = 'CYCLES' }
            return Invoke-External $exe $args
        }
        'ffmpeg-transcode' {
            $exe = Get-CommandPath 'ffmpeg.exe'; if (-not $exe) { throw 'FFmpeg is not installed or not on PATH.' }
            $input = Resolve-SafePath ([string]$spec.input); $output = Resolve-SafePath ([string]$spec.output) -Output
            $preset = if ($spec.preset -in @('slow','medium','fast')) { [string]$spec.preset } else { 'medium' }
            return Invoke-External $exe @('-y','-i',$input,'-c:v','h264_nvenc','-preset',$preset,'-c:a','aac','-b:a','192k',$output)
        }
        'whisper-transcribe' {
            $python = Get-CommandPath 'python.exe'; if (-not $python) { throw 'Python is not installed or not on PATH.' }
            $input = Resolve-SafePath ([string]$spec.input); $worker = Resolve-SafePath (Join-Path $Root 'transcribe.py'); $output = Resolve-SafePath ([string]$spec.output) -Output
            return Invoke-External $python @($worker,$input,'--output-dir',$output,'--model',$(if($spec.model){[string]$spec.model}else{'small.en'}))
        }
        'comfyui-workflow' {
            $workflow = Resolve-SafePath ([string]$spec.workflow)
            $endpoint = if ($spec.endpoint) { [string]$spec.endpoint } else { 'http://127.0.0.1:8188/prompt' }
            if ($endpoint -notmatch '^http://(127\.0\.0\.1|localhost):\d+/prompt$') { throw 'ComfyUI endpoint must be local.' }
            $reply = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType 'application/json' -Body (Get-Content -LiteralPath $workflow -Raw) -TimeoutSec 30
            return [ordered]@{ exit_code=0; stdout=($reply | ConvertTo-Json -Depth 8 -Compress); stderr='' }
        }
        default { throw "Unsupported Windows workload: $Type" }
    }
}

function Send-Heartbeat($Config) {
    $body = [ordered]@{ device_id=$Config.device_id; ts=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); hostname=$env:COMPUTERNAME; platform='Windows'; node_class='gpu-worker'; agent_version=$AgentVersion; pid=$PID }
    $null = Invoke-Swarm -Action 'heartbeat' -Method POST -Body $body -Config $Config
}

function Send-Result($Config, $Job, $Result) {
    $out = [string]$Result.stdout; $err = [string]$Result.stderr
    $body = [ordered]@{ job_id=[string]$Job.id; device_id=$Config.device_id; type=[string]$Job.type; exit_code=[int]$Result.exit_code; stdout=$out.Substring(0,[math]::Min(4000,$out.Length)); stderr=$err.Substring(0,[math]::Min(4000,$err.Length)); ts=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
    $null = Invoke-Swarm -Action 'job-complete' -Method POST -Body $body -Config $Config
}

function Run-Agent {
    $config = Get-Config; Write-AgentLog "Hybrid worker $AgentVersion started as $($config.device_id)"; $lastHeartbeat = [datetime]::MinValue
    while ($true) {
        try {
            if (((Get-Date) - $lastHeartbeat).TotalSeconds -ge 60) { Send-Heartbeat $config; $lastHeartbeat = Get-Date }
            $response = Invoke-Swarm -Action 'swarm-poll' -Config $config -Query @{ device_id=$config.device_id }
            foreach ($job in @($response.jobs)) {
                $saladRecord = $null
                try {
                    Write-AgentLog "Starting $($job.type) job $($job.id)"
                    if ($job.type -in @('workstation-selftest','blender-render','ffmpeg-transcode','whisper-transcribe','comfyui-workflow')) { $saladRecord = Suspend-Salad }
                    $result = Invoke-Workload -Type ([string]$job.type) -Command ([string]$(if($job.cmd){$job.cmd}else{$job.command}))
                } catch { $result = [ordered]@{ exit_code=1; stdout=''; stderr=$_.Exception.Message } }
                finally { if ($saladRecord) { Resume-Salad $saladRecord } }
                Send-Result $config $job $result; Write-AgentLog "Finished $($job.id) exit=$($result.exit_code)"
            }
        } catch {
            $detail = $_.Exception.Message
            if ($_.ErrorDetails.Message) { $detail += " body=$($_.ErrorDetails.Message)" }
            Write-AgentLog "Poll error: $detail"
        }
        Start-Sleep -Seconds ([math]::Max(5,$PollSeconds))
    }
}

function Install-Agent {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 750
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    if ([IO.Path]::GetFullPath($PSCommandPath) -ne [IO.Path]::GetFullPath($AgentPath)) { Copy-Item -LiteralPath $PSCommandPath -Destination $AgentPath -Force }
    $password = Read-PlainDashboardPassword
    $cipher = ConvertTo-SecureString $password -AsPlainText -Force | ConvertFrom-SecureString
    [ordered]@{ device_id=$DeviceId; swarm_url=$SwarmUrl; password_cipher=$cipher } | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding utf8
    $config = Get-Config; $null = Invoke-Swarm -Action 'queue-status' -Config $config
    $pwsh = (Get-Command pwsh.exe).Source
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentPath`" -Mode Run"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Safe hybrid GPU workload worker for curtbrag.com.' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Installed and started $DeviceId. Log: $LogPath" -ForegroundColor Green
}

switch ($Mode) {
    'Audit' { Get-Audit | ConvertTo-Json -Depth 8 }
    'Install' { Install-Agent }
    'InstallTools' { Install-ProductionTools }
    'Run' { Run-Agent }
    'Status' { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; [ordered]@{ installed=(Test-Path $AgentPath); task_state=if($task){[string]$task.State}else{'Missing'}; audit=(Get-Audit); log=$LogPath } | ConvertTo-Json -Depth 9 }
    'Stop' { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Write-Host 'Hybrid worker stopped. Salad was not changed.' }
}
