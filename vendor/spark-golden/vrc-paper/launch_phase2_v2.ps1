$ErrorActionPreference = "Stop"
Set-Location "D:\Program\spark-main\spark-main\vrc-paper"

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$resultsRoot = "D:\Program\spark-main\spark-main\vrc-paper\results_full_$ts"

# Write a self-contained wrapper that the detached process will run
$wrapperPath = Join-Path (Get-Location) "_detached_full72_wrapper.ps1"
$wrapperContent = @"
`$ErrorActionPreference = "Continue"
Set-Location "D:\Program\spark-main\spark-main\vrc-paper"
`$env:VRC_RESULTS_ROOT = "$resultsRoot"
`$env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples"
`$env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
`$env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public"
`$env:VRC_CDN2_OBJECT_PATH = "asundqui/rad/260217/coit-40m-sh1-lod.rad"
`$env:VRC_CDN2_OBJECT_PATH_HOBBITON = "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad"
`$env:VRC_SESSION_DIGEST_FAIL = "1"
`$env:VRC_RUN_FULL_PIPELINE = "1"
`$env:VRC_SKIP_PREFLIGHT = "1"
`$env:VRC_DELIVERY_PROFILE = "origin_only"
`$env:VRC_CDN_LABEL = "hpc"
`$env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "0"
& ".\run_autonomous_pipeline_detached.ps1"
"@
Set-Content -Path $wrapperPath -Value $wrapperContent -Encoding UTF8

Write-Host "=== Phase 2: Full 72-run detached orchestrator ==="
Write-Host "VRC_RESULTS_ROOT = $resultsRoot"
Write-Host "Wrapper: $wrapperPath"
Write-Host ""

$proc = Start-Process powershell -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File', $wrapperPath
) -WindowStyle Normal -PassThru

Start-Sleep -Seconds 3
Write-Host "A. Orchestrator PID: $($proc.Id)"
Write-Host "B. Results: $resultsRoot"
Write-Host "C. Monitor: Get-Content $resultsRoot\runner_logs\orchestrator_*.out.log -Wait"
Write-Host "D. Resume: powershell -ExecutionPolicy Bypass -File resume_real_experiment.ps1"
Write-Host "E. Stop: powershell -ExecutionPolicy Bypass -File stop_vrc_experiment.ps1"
Write-Host "F. Safe to leave: YES (detached)"

$proc.Id | Out-File -FilePath "RUNNER_PID.txt" -Encoding UTF8

# Verify it's still running
if (-not $proc.HasExited) {
  Write-Host "Status: RUNNING"
} else {
  Write-Host "WARNING: Process exited with code $($proc.ExitCode)"
  if (Test-Path "$resultsRoot\runner_logs") {
    Get-ChildItem "$resultsRoot\runner_logs" | ForEach-Object { Write-Host "  Log: $($_.Name) ($($_.Length) bytes)" }
  }
}
