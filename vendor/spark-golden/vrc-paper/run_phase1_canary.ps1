$ErrorActionPreference = "Continue"
Set-Location "D:\Program\spark-main\spark-main\vrc-paper"

$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_rerun_20260516_202047"
$env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples"
$env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
$env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public"
$env:VRC_CDN2_OBJECT_PATH = "asundqui/rad/260217/coit-40m-sh1-lod.rad"
$env:VRC_CDN2_OBJECT_PATH_HOBBITON = "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad"
$env:VRC_SESSION_DIGEST_FAIL = "1"
$env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "1"

Write-Host "=== Phase 1: dual_cdn_hybrid_retest.ps1 ==="
Write-Host "Started at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

& ".\dual_cdn_hybrid_retest.ps1"
$exitCode = $LASTEXITCODE
Write-Host ""
Write-Host "=== dual_cdn_hybrid_retest exit code: $exitCode ==="
Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

exit $exitCode
