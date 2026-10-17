# 24h distributed network benchmark — delegates to Node runner (hard gates + manifest).
# Requires accepted canary: 2026-05-20T05-54-12
#
#   .\scripts\run_24h_distributed_network_experiments.ps1
#   .\scripts\run_24h_distributed_network_experiments.ps1 -Resume -BatchDir "...\260506_distributed_network_benchmark\..."

param(
    [string]$BatchDir = "",
    [string]$Matrix = "round1",
    [string]$CanaryBatch = "2026-05-20T05-54-12",
    [switch]$Resume,
    [switch]$SkipCanaryCheck
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$nodeArgs = @("scripts/run_24h_distributed_network_experiment.mjs", "--matrix=$Matrix", "--canaryBatch=$CanaryBatch")
if ($BatchDir) { $nodeArgs += "--batchDir=$BatchDir" }
if ($Resume) { $nodeArgs += "--resume" }
if ($SkipCanaryCheck) { $nodeArgs += "--skipCanaryCheck" }

Write-Host "[ps1] Starting 24h runner: node $($nodeArgs -join ' ')"
& node @nodeArgs
exit $LASTEXITCODE
