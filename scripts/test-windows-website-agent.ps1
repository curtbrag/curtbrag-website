param([switch]$Live)
$ErrorActionPreference = 'Stop'
$candidate = Join-Path $PSScriptRoot 'curt-hybrid-website-test-agent.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($candidate, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load only four functions; never evaluate agent startup, config, scheduler, or GPU code.
$names = @('Get-CommandPath','Parse-JobSpec','Invoke-External','Invoke-Workload')
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names}, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
$Root = $PSScriptRoot
$python = Get-CommandPath 'python.exe'
if (-not $python) { throw 'Test runtime needs Python.' }
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$invalid = Invoke-Workload 'website-test' '{"url":"http://127.0.0.1/"}'
$report = $invalid.stdout | ConvertFrom-Json
Assert ($invalid.exit_code -eq 1 -and -not $report.ok -and $report.kind -eq 'website-load-test') 'Rejected URL must preserve JSON report and exit 1.'
Assert ($report.error -match 'HTTPS') 'Unsafe URL must be rejected before networking.'

foreach ($settings in @('{"url":"https://curtbrag.com/","command":"anything"}', '{"url":5}', '{}', '[]')) {
    $rejected = $false
    try { $null = Invoke-Workload 'website-test' $settings } catch { $rejected = $true }
    Assert $rejected 'Unexpected settings must be rejected before process execution.'
}

$literal = Invoke-Workload 'website-test' '{"url":"https://curtbrag.com/$(echo injected)"}'
Assert ($literal.exit_code -eq 1 -and ($literal.stdout | ConvertFrom-Json).error -match 'characters') 'Command-like URL text must remain data and be rejected.'

$timer = [Diagnostics.Stopwatch]::StartNew()
$bounded = Invoke-External $python @('-c','import time; time.sleep(5)') -TimeoutSeconds 1
$timer.Stop()
Assert ($bounded.exit_code -eq 124 -and $timer.Elapsed.TotalSeconds -lt 4) 'Bounded process must be stopped at its deadline.'

$captured = Invoke-External $python @('-c','import sys; print("report"); print("detail", file=sys.stderr); sys.exit(7)') -TimeoutSeconds 3
Assert ($captured.exit_code -eq 7 -and $captured.stdout -eq 'report' -and $captured.stderr -eq 'detail') 'Exit code and both streams must be preserved.'

$legacy = Invoke-External $python @('-c','print("legacy")')
Assert ($legacy.exit_code -eq 0 -and $legacy.stdout -eq 'legacy') 'Existing calls without a timeout must retain behavior.'

$run = $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Run-Agent'}, $false)[0].Extent.Text
Assert (-not ($run -match "'website-test'.*Suspend-Salad")) 'Website test must not pause GPU workloads.'

if ($Live) {
    $result = Invoke-Workload 'website-test' '{"url":"https://curtbrag.com/"}'
    $page = $result.stdout | ConvertFrom-Json
    Assert ($result.exit_code -eq 0 -and $page.ok -and $page.status -eq 200) 'Owned live page must produce a successful bounded report.'
    [ordered]@{status=$page.status; title=$page.title; bytes=$page.bytes; total_ms=$page.total_ms} | ConvertTo-Json -Compress
}
'Windows candidate: syntax, URL settings, data-only arguments, child-process deadline, output/exit capture, and legacy invocation passed.'

