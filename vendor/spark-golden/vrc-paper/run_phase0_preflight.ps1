$ErrorActionPreference = "Continue"
Set-Location "D:\Program\spark-main\spark-main\vrc-paper"

$ts = "20260516_202047"
$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_rerun_$ts"
$env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples"
$env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
$env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public"
$env:VRC_CDN2_OBJECT_PATH = "asundqui/rad/260217/coit-40m-sh1-lod.rad"
$env:VRC_CDN2_OBJECT_PATH_HOBBITON = "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad"
$env:VRC_SESSION_DIGEST_FAIL = "1"
$env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "1"

Write-Host "=== Environment ==="
Write-Host "VRC_RESULTS_ROOT = $env:VRC_RESULTS_ROOT"
Write-Host "VRC_HPC_ASSET_BASE = $env:VRC_HPC_ASSET_BASE"
Write-Host "VRC_CDN_ASSET_BASE = $env:VRC_CDN_ASSET_BASE"
Write-Host "VRC_CDN2_ASSET_BASE = $env:VRC_CDN2_ASSET_BASE"
Write-Host "VRC_CDN2_OBJECT_PATH = $env:VRC_CDN2_OBJECT_PATH"
Write-Host ""

Write-Host "=== Running dual_cdn_preflight.mjs --assets-only ==="
node experiments/dual_cdn_preflight.mjs --assets-only
$exitCode = $LASTEXITCODE
Write-Host ""
Write-Host "=== Preflight exit code: $exitCode ==="

if (Test-Path "$env:VRC_RESULTS_ROOT\summary\preflight_report.json") {
    Write-Host "=== preflight_report.json ==="
    Get-Content "$env:VRC_RESULTS_ROOT\summary\preflight_report.json"
}
if (Test-Path "$env:VRC_RESULTS_ROOT\summary\endpoint_audit.csv") {
    Write-Host ""
    Write-Host "=== endpoint_audit.csv ==="
    Get-Content "$env:VRC_RESULTS_ROOT\summary\endpoint_audit.csv"
}

exit $exitCode
