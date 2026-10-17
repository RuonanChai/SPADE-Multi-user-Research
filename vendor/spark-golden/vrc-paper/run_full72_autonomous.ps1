# Launch full 72-run distributed matrix with fail-continue + auto-resume.
# Detached-friendly: Start-Process powershell -File run_full72_autonomous.ps1
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
if (-not $env:VRC_RESULTS_ROOT -or -not $env:VRC_RESULTS_ROOT.Trim()) {
  $env:VRC_RESULTS_ROOT = Join-Path $ScriptDir "results_full_$ts"
}

$env:VRC_RUN_FULL_PIPELINE = "1"
$env:VRC_USE_DISTRIBUTED = "1"
$env:VRC_DISTRIBUTED = "true"
$env:VRC_DELIVERY_PROFILE = if ($env:VRC_DELIVERY_PROFILE) { $env:VRC_DELIVERY_PROFILE } else { "vrc_guided_hybrid" }
$env:VRC_CDN_LABEL = if ($env:VRC_CDN_LABEL) { $env:VRC_CDN_LABEL } else { "cdn1" }
Remove-Item Env:VRC_NO_HALT_ON_CANARY -ErrorAction SilentlyContinue
Remove-Item Env:VRC_CONTINUE_ON_FAIL -ErrorAction SilentlyContinue
$env:VRC_SUMMARY_APPEND = "1"
$env:VRC_HEADLESS = "true"
$env:VRC_CAPTURE_MODE = "parallel"
$env:VRC_ADAPTIVE_VISUAL = if ($env:VRC_ADAPTIVE_VISUAL) { $env:VRC_ADAPTIVE_VISUAL } else { "1" }
$env:VRC_ADAPT_MAX_FULL_ROUNDS = if ($env:VRC_ADAPT_MAX_FULL_ROUNDS) { $env:VRC_ADAPT_MAX_FULL_ROUNDS } else { "6" }

if (-not $env:VRC_HPC_ASSET_BASE) { $env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples" }
if (-not $env:VRC_CDN_ASSET_BASE) { $env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev" }
if (-not $env:VRC_CDN2_ASSET_BASE) { $env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public" }

New-Item -ItemType Directory -Force -Path $env:VRC_RESULTS_ROOT | Out-Null
$logDir = Join-Path $env:VRC_RESULTS_ROOT "runner_logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "full72_orchestrator.out.log"
$errLog = Join-Path $logDir "full72_orchestrator.err.log"

Write-Host "VRC_RESULTS_ROOT=$($env:VRC_RESULTS_ROOT)" -ForegroundColor Green
Write-Host "Launching run_autonomous_pipeline_detached.ps1 (72-run, no-halt, skip prefull)..." -ForegroundColor Cyan
Write-Host "Logs: $outLog"

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "run_autonomous_pipeline_detached.ps1") `
  *>> $outLog 2>> $errLog
$code = $LASTEXITCODE
"EXIT=$code at $(Get-Date -Format o)" | Add-Content -Path $outLog
exit $code
