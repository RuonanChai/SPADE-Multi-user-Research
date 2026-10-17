$ErrorActionPreference = "Continue"
Set-Location "D:\Program\spark-main\spark-main\vrc-paper"

$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_rerun_20260516_202047"
$env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples"
$env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
$env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public"
$env:VRC_CDN2_OBJECT_PATH = "asundqui/rad/260217/coit-40m-sh1-lod.rad"
$env:VRC_CDN2_OBJECT_PATH_HOBBITON = "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad"

Write-Host "=== Preflight re-test (fetch-based probeUrl) ==="
node experiments/dual_cdn_preflight.mjs --assets-only
$code = $LASTEXITCODE
Write-Host "exit=$code"
exit $code
