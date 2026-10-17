# Minimal distributed canary gate: canary1a_metrics + canary2_full only.
# Halts on first failure (VRC_NO_HALT_ON_CANARY must NOT be set).
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
if (-not $env:VRC_RESULTS_ROOT -or -not $env:VRC_RESULTS_ROOT.Trim()) {
  $env:VRC_RESULTS_ROOT = Join-Path $ScriptDir "results_canary_smoke_$ts"
}

Remove-Item Env:VRC_NO_HALT_ON_CANARY -ErrorAction SilentlyContinue
Remove-Item Env:VRC_RUN_FULL_PIPELINE -ErrorAction SilentlyContinue
Remove-Item Env:VRC_SKIP_PREFULL_GATE -ErrorAction SilentlyContinue
Remove-Item Env:VRC_CONTINUE_ON_FAIL -ErrorAction SilentlyContinue

$env:VRC_USE_DISTRIBUTED = "1"
$env:VRC_DISTRIBUTED = "true"
$env:VRC_CANARY_ONLY = "1"
$env:VRC_CANARY_NAMES = "canary1a_metrics,canary2_full"
$env:VRC_DELIVERY_PROFILE = if ($env:VRC_DELIVERY_PROFILE) { $env:VRC_DELIVERY_PROFILE } else { "vrc_guided_hybrid" }
$env:VRC_CDN_LABEL = if ($env:VRC_CDN_LABEL) { $env:VRC_CDN_LABEL } else { "cdn1" }
$env:VRC_SUMMARY_APPEND = "1"
$env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "1"

if (-not $env:VRC_HPC_ASSET_BASE) { $env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples" }
if (-not $env:VRC_CDN_ASSET_BASE) { $env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev" }

New-Item -ItemType Directory -Force -Path $env:VRC_RESULTS_ROOT | Out-Null
Write-Host "VRC_RESULTS_ROOT=$($env:VRC_RESULTS_ROOT)" -ForegroundColor Green
Write-Host "Running canary1a_metrics + canary2_full (halt on fail)..." -ForegroundColor Cyan

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "run_autonomous_pipeline_detached.ps1")
exit $LASTEXITCODE
