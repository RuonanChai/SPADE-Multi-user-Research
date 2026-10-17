# Local latency probe: CDP Network audit first, then optional Chrome trace.
# Phase 7 — u0 only, Full, nearby, 1 trial. No 72-run, no u0-u3 quad.
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $ScriptDir

function Run-Probe([string]$Label, [hashtable]$EnvExtra) {
    $ts = Get-Date -Format "yyyyMMdd_HHmmss"
    $root = Join-Path $ScriptDir "results_perf_probe_${Label}_$ts"
    $env:VRC_RESULTS_ROOT = $root
    $env:VRC_USE_DISTRIBUTED = "0"
    $env:VRC_DISTRIBUTED = "0"
    $env:VRC_USER_INDICES = "0"
    $env:VRC_METHODS = "Full"
    $env:VRC_SCENARIOS = "nearby"
    $env:VRC_TRIALS = "1"
    $env:VRC_CAPTURE_MODE = "metrics_only"
    $env:VRC_HEADLESS = "true"
    $env:VRC_WRITE_BOTTLENECK_SUMMARY = "1"
    $env:VRC_RESOURCE_TIMING_AUDIT = "1"
    Remove-Item Env:VRC_NO_HALT_ON_CANARY -ErrorAction SilentlyContinue
    Remove-Item Env:VRC_CONTINUE_ON_FAIL -ErrorAction SilentlyContinue
    foreach ($k in $EnvExtra.Keys) { Set-Item -Path "env:$k" -Value $EnvExtra[$k] }
    if (-not $env:VRC_HPC_ASSET_BASE) { $env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090/examples" }
    if (-not $env:VRC_CDN_ASSET_BASE) { $env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev" }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Write-Host "`n=== PROBE $Label VRC_RESULTS_ROOT=$root ===" -ForegroundColor Cyan
    & node (Join-Path $ScriptDir "experiments\run_experiment.mjs")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "PROBE $Label exit=$LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }
    Write-Host "PROBE $Label OK -> $root" -ForegroundColor Green
    return $root
}

# Step 1: CDP network + ResourceTiming only
$root1 = Run-Probe "network" @{
    VRC_CDP_NETWORK_AUDIT = "1"
    VRC_CDP_PERF_TRACE = "0"
}

# Step 2: add Chrome trace for u0
$root2 = Run-Probe "network_trace" @{
    VRC_CDP_NETWORK_AUDIT = "1"
    VRC_CDP_PERF_TRACE = "1"
    VRC_PERF_TRACE_USERS = "0"
}

Write-Host "`n=== DONE ===" -ForegroundColor Green
Write-Host "network audit run: $root1"
Write-Host "network+trace run: $root2"
Write-Host "Inspect:"
Write-Host "  raw/*/cdp_network_audit.csv"
Write-Host "  raw/*/resource_timing_audit.csv"
Write-Host "  raw/*/per_client_metrics.csv"
Write-Host "  raw/*/single_user_bottleneck_summary.md"
Write-Host "  raw/*/perf_traces/u0.trace.json"
