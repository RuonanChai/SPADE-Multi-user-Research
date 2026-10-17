$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$ResultsRoot = if ($env:VRC_RESULTS_ROOT) { $env:VRC_RESULTS_ROOT } else { Join-Path $ScriptDir 'results_260513' }
$env:VRC_RESULTS_ROOT = $ResultsRoot
New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ResultsRoot 'runner_logs') | Out-Null
$out = Join-Path $ResultsRoot "runner_logs\master_${ts}.out.log"
$err = Join-Path $ResultsRoot "runner_logs\master_${ts}.err.log"
$master = Join-Path $ScriptDir 'run_autonomous_pipeline_detached.ps1'
$p = Start-Process -FilePath 'powershell' `
    -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$master `
    -WorkingDirectory $ScriptDir `
    -RedirectStandardOutput $out `
    -RedirectStandardError  $err `
    -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $ResultsRoot 'RUNNER_PID.txt') -Value "$($p.Id)`nmaster`n$out`n$err"
Write-Host "PID=$($p.Id)"
Write-Host "OUT=$out"
Write-Host "ERR=$err"
Write-Host "RESULTS_ROOT=$ResultsRoot"
