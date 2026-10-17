$ErrorActionPreference = "Stop"
Set-Location "D:\Program\spark-main\spark-main\vrc-paper"

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_full_$ts"
$env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples"
$env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
$env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public"
$env:VRC_CDN2_OBJECT_PATH = "asundqui/rad/260217/coit-40m-sh1-lod.rad"
$env:VRC_CDN2_OBJECT_PATH_HOBBITON = "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad"
$env:VRC_SESSION_DIGEST_FAIL = "1"
$env:VRC_RUN_FULL_PIPELINE = "1"
$env:VRC_SKIP_PREFLIGHT = "1"
$env:VRC_DELIVERY_PROFILE = "origin_only"
$env:VRC_CDN_LABEL = "hpc"
$env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "0"

Write-Host "=== Phase 2: Full 72-run detached orchestrator ==="
Write-Host "VRC_RESULTS_ROOT = $($env:VRC_RESULTS_ROOT)"
Write-Host "Launching run_autonomous_pipeline_detached.ps1..."

$proc = Start-Process powershell -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',
  (Join-Path (Get-Location) 'run_autonomous_pipeline_detached.ps1')
) -WindowStyle Normal -PassThru

Write-Host ""
Write-Host "A. Orchestrator PID: $($proc.Id)"
Write-Host "B. stdout log: runner_logs\orchestrator_$ts.out.log"
Write-Host "C. stderr log: runner_logs\orchestrator_$ts.err.log"
Write-Host "D. Monitor: Get-Content runner_logs\orchestrator_$ts.out.log -Wait"
Write-Host "E. Resume: powershell -ExecutionPolicy Bypass -File resume_real_experiment.ps1"
Write-Host "F. Stop: powershell -ExecutionPolicy Bypass -File stop_vrc_experiment.ps1"
Write-Host "G. Check: Get-Content RUN_STATUS.md; Get-Content NEXT_ACTION.md"
Write-Host "H. Safe to leave: YES (detached)"

$proc.Id | Out-File -FilePath "RUNNER_PID.txt" -Encoding UTF8
