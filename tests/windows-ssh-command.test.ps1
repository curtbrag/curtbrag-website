#Requires -Version 7.0
# Load only the SSH function and replace its process constructor with a fixture.
# Keep real ProcessStartInfo/ArgumentList; no SSH, config or bridge startup runs.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../scripts/curt-cluster-bridge-windows.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Bridge source does not parse.' }
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Phone' }, $true))
if ($functions.Count -ne 1) { throw 'Missing isolated SSH function.' }
$functionText = $functions[0].Extent.Text
$constructor = '[Diagnostics.Process]::new()'
if (($functionText.Split($constructor).Count - 1) -ne 1) { throw 'Expected exactly one process constructor.' }
. ([scriptblock]::Create($functionText.Replace($constructor, '(New-SshProcessFixture)')))

function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ($Actual -cne $Expected) { throw "$Message expected=$Expected actual=$Actual" } }
function New-SshReaderFixture([string]$Text, [switch]$Pending) {
    $reader = [pscustomobject]@{ Text=$Text; Pending=[bool]$Pending }
    $reader | Add-Member ScriptMethod ReadToEndAsync {
        if ($this.Pending) { return [Threading.Tasks.TaskCompletionSource[string]]::new().Task }
        return [Threading.Tasks.Task]::FromResult([string]$this.Text)
    }
    return $reader
}
function New-SshProcessFixture {
    $process = [pscustomobject]@{
        StartInfo=$null; ExitCode=$script:exitFixture; Mode=$script:modeFixture
        StandardOutput=(New-SshReaderFixture "fixture output`n" -Pending:($script:modeFixture -eq 'output-timeout'))
        StandardError=(New-SshReaderFixture '')
        Started=$false; Disposed=$false; Killed=$false; KillTree=$false
        Waits=[Collections.Generic.List[int]]::new()
    }
    $process | Add-Member ScriptMethod Start {
        $this.Started = $true
        if ($this.Mode -eq 'start-failure') { throw 'private fixture failure details' }
        return $true
    }
    $process | Add-Member ScriptMethod WaitForExit {
        param([int]$Milliseconds)
        $this.Waits.Add($Milliseconds)
        return ($this.Mode -ne 'command-timeout' -or $this.Waits.Count -gt 1)
    }
    $process | Add-Member ScriptMethod Kill { param([bool]$EntireProcessTree) $this.Killed=$true; $this.KillTree=$EntireProcessTree }
    $process | Add-Member ScriptMethod Dispose { $this.Disposed=$true }
    $script:processFixture = $process
    return $process
}
function Invoke-SshFixture([string]$Command, [string]$Mode='success', [int]$ExitCode=0) {
    $script:modeFixture = $Mode
    $script:exitFixture = $ExitCode
    $script:ssh = 'fixture-ssh.exe'
    $script:key = 'C:\fixture key\id_ed25519'
    $result = Invoke-Phone -IP '192.0.2.1' -Remote $Command -User 'fixture-user' -Port 2222
    $process = $script:processFixture
    Assert-True ($process.Started -and $process.Disposed) 'Start and dispose the isolated process.'
    Assert-Equal $process.StartInfo.FileName $script:ssh 'Use the configured executable.'
    Assert-Equal $process.StartInfo.UseShellExecute $false 'Do not launch a command shell.'
    Assert-Equal $process.StartInfo.CreateNoWindow $true 'Keep SSH hidden.'
    Assert-True ($process.StartInfo.RedirectStandardOutput -and $process.StartInfo.RedirectStandardError) 'Keep both output streams captured.'
    if ($Mode -eq 'start-failure') {
        Assert-Equal $process.Waits.Count 0 'A startup failure must not wait for an absent process.'
    } else {
        Assert-Equal $process.Waits[0] 90000 'Keep the bounded command wait.'
    }
    $expectedArguments = @(
        '-n','-p','2222','-i',$script:key,
        '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=5',
        '-o','ConnectionAttempts=1','-o','ServerAliveInterval=2','-o','ServerAliveCountMax=2',
        '-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL','-o','LogLevel=ERROR',
        'fixture-user@192.0.2.1'
    )
    $arguments = $process.StartInfo.ArgumentList
    Assert-Equal $arguments.Count ($expectedArguments.Count + 1) 'Keep the remote command as one argument.'
    for ($index=0; $index -lt $expectedArguments.Count; $index++) {
        Assert-Equal $arguments[$index] $expectedArguments[$index] 'Preserve existing SSH options, target and key argument.'
    }
    return [pscustomobject]@{ Result=$result; Command=$arguments[$arguments.Count - 1]; Process=$process }
}

$loopLines = @('for item in one two; do', '  printf ''%s\n'' "$item"', 'done')
$loopLf = $loopLines -join "`n"
$fixture = Invoke-SshFixture ($loopLines -join "`r`n")
Assert-Equal $fixture.Result.Exit 0 'A normal SSH result succeeds.'
Assert-Equal $fixture.Command $loopLf 'Windows here-string loop must arrive as POSIX newlines.'
Assert-Equal ($fixture.Result.Output -join ',') 'fixture output' 'Preserve captured output handling.'

$fixture = Invoke-SshFixture $loopLf
Assert-Equal $fixture.Command $loopLf 'An existing LF command must remain exact.'
$quotedLf = @'
printf '%s\n' "l’été 東京" 'single' "double" '$(literal); `tick`'
'@
$fixture = Invoke-SshFixture ($quotedLf + "`r`n" + 'printf ''next\n''')
Assert-Equal $fixture.Command ($quotedLf + "`n" + 'printf ''next\n''') 'Preserve quotes, Unicode and shell text as one argument.'
$bareCr = "printf 'left`rright'"
$fixture = Invoke-SshFixture $bareCr
Assert-Equal $fixture.Command $bareCr 'An intentional unpaired carriage return must stay intact.'
$fixture = Invoke-SshFixture ($bareCr + "`r`n" + $loopLf)
Assert-Equal $fixture.Command ($bareCr + "`n" + $loopLf) 'Mixed line endings must preserve bare CR and existing LF.'

$fixture = Invoke-SshFixture $loopLf -Mode 'command-timeout'
Assert-Equal $fixture.Result.Exit 124 'Command timeout must remain a failure.'
Assert-Equal ($fixture.Result.Output -join ',') 'SSH command timed out' 'Retain command timeout reporting.'
Assert-Equal ($fixture.Process.Waits -join ',') '90000,3000' 'Keep the bounded cleanup wait.'
Assert-True ($fixture.Process.Killed -and $fixture.Process.KillTree) 'Stop the timed-out process tree.'
$fixture = Invoke-SshFixture $loopLf -Mode 'output-timeout'
Assert-Equal $fixture.Result.Exit 124 'Output timeout must remain a failure.'
Assert-Equal ($fixture.Result.Output -join ',') 'SSH output timed out' 'Retain the bounded output timeout path.'
$fixture = Invoke-SshFixture $loopLf -ExitCode 17
Assert-Equal $fixture.Result.Exit 17 'Keep the actual SSH failure exit code.'
$fixture = Invoke-SshFixture $loopLf -Mode 'start-failure'
Assert-Equal $fixture.Result.Exit 1 'Process startup failures must remain failures.'
Assert-True (($fixture.Result.Output -join ',') -like 'SSH invocation failed:*' -and ($fixture.Result.Output -join ',') -notmatch 'private fixture') 'Keep sanitized startup failure reporting.'
Write-Output 'Windows SSH command: CRLF, LF, quotes/Unicode, bare CR, hidden options, timeouts and failures passed; no SSH or bridge startup used.'
