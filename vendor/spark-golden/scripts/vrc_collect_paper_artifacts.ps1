# vrc_collect_paper_artifacts.ps1
# 在主编排成功后，把论文写作常用产物拷到 paper_bundle/（可选再打 zip）。
# 从仓库根执行：
#   powershell -ExecutionPolicy Bypass -File scripts\vrc_collect_paper_artifacts.ps1 -ResultsRoot "D:\...\vrc-paper\results_xxx"
#
param(
    [string]$ResultsRoot = "",
    [switch]$Zip
)

$ErrorActionPreference = "Continue"
if (-not $ResultsRoot) { $ResultsRoot = $env:VRC_RESULTS_ROOT }
if (-not $ResultsRoot) {
    Write-Error "Pass -ResultsRoot or set env VRC_RESULTS_ROOT. Example: npm run vrc:paper:bundle -- -ResultsRoot D:\path\to\vrc-paper\results_xxx -Zip"
    exit 1
}
$bundle = Join-Path $ResultsRoot "paper_bundle"
New-Item -ItemType Directory -Force -Path $bundle | Out-Null

$items = @(
    "VALIDATION_REPORT.md",
    "RUN_STATUS.md",
    "RUN_STATE.json",
    "NEXT_ACTION.md",
    "PROVENANCE.md",
    "DEBUG_LOG.md"
)
foreach ($n in $items) {
    $p = Join-Path $ResultsRoot $n
    if (Test-Path $p) { Copy-Item $p $bundle -Force }
}
$sum = Join-Path $ResultsRoot "summary"
if (Test-Path $sum) { Copy-Item $sum (Join-Path $bundle "summary") -Recurse -Force }
$fig = Join-Path $ResultsRoot "figures"
if (Test-Path $fig) { Copy-Item $fig (Join-Path $bundle "figures") -Recurse -Force }
$rep = Join-Path $ResultsRoot "final_report.md"
if (Test-Path $rep) { Copy-Item $rep $bundle -Force }
$screens = Join-Path $ResultsRoot "screenshots"
if (Test-Path $screens) {
    $cap = Join-Path $bundle "screenshots_sample"
    New-Item -ItemType Directory -Force -Path $cap | Out-Null
    Get-ChildItem $screens -File -ErrorAction SilentlyContinue | Select-Object -First 24 | Copy-Item -Destination $cap -Force
}

Write-Host "Paper bundle: $bundle"
if ($Zip) {
    $zipPath = Join-Path (Split-Path $ResultsRoot -Parent) ("paper_bundle_" + (Split-Path $ResultsRoot -Leaf) + ".zip")
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path $bundle -DestinationPath $zipPath
    Write-Host "ZIP: $zipPath"
}
