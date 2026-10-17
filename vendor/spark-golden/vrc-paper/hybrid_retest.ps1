# Hybrid retest — **distributed only** (Worker1: u0/u1 + Vite/sync/coordinator; Worker2 SSH: u2/u3).
# Requires: experiments\distributed_lab.json, OpenSSH ssh/scp, Worker2 reachable. No local 4-Chrome fallback.

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$env:VRC_DISTRIBUTED = "true"

$defaultResults = Join-Path $RepoRoot "results_hybrid_distributed_260513"
$ResultsRoot = if ($env:VRC_RESULTS_ROOT -and $env:VRC_RESULTS_ROOT.Trim()) {
  $env:VRC_RESULTS_ROOT.Trim()
} else {
  $defaultResults
}
$env:VRC_RESULTS_ROOT = $ResultsRoot
$env:VRC_SUMMARY_APPEND = "1"
$env:VRC_HOT_THRESHOLD = "2"
$env:VRC_CDN_FALLBACK_TO_HPC = "true"
if (-not $env:VRC_HPC_ASSET_BASE) { $env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090" }
if (-not $env:VRC_CDN_ASSET_BASE) { $env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev" }

# Lab defaults (override before running if needed)
if (-not $env:VITE_PORT) { $env:VITE_PORT = "9200" }
if (-not $env:VRC_SYNC_PORT) { $env:VRC_SYNC_PORT = "9201" }
if (-not $env:VITE_HOST) { $env:VITE_HOST = "0.0.0.0" }
if (-not $env:VRC_SYNC_HOST) { $env:VRC_SYNC_HOST = "0.0.0.0" }
if (-not $env:VRC_SYNC_BIND) { $env:VRC_SYNC_BIND = "0.0.0.0" }
if (-not $env:VRC_CONTROLLER_HOST) { $env:VRC_CONTROLLER_HOST = "10.4.158.143" }
if (-not $env:VRC_WORKER1_HOST) { $env:VRC_WORKER1_HOST = "10.4.158.143" }
if (-not $env:VRC_WORKER2_HOST) { $env:VRC_WORKER2_HOST = "10.4.146.68" }
if (-not $env:VRC_WORKER2_SSH) { $env:VRC_WORKER2_SSH = "10.4.146.68" }
if (-not $env:VRC_USERS_WORKER1) { $env:VRC_USERS_WORKER1 = "u0,u1" }
if (-not $env:VRC_USERS_WORKER2) { $env:VRC_USERS_WORKER2 = "u2,u3" }
if (-not $env:VRC_PUBLIC_PAGE_BASE) { $env:VRC_PUBLIC_PAGE_BASE = "http://10.4.158.143:9200" }
if (-not $env:VRC_PUBLIC_SYNC_URL) { $env:VRC_PUBLIC_SYNC_URL = "ws://10.4.158.143:9201" }

function Bump-Seq {
  if (-not $script:HybridRunSeq) { $script:HybridRunSeq = 0 }
  $script:HybridRunSeq++
  $env:VRC_RUN_SEQ = "$script:HybridRunSeq"
}

function Test-SshWorker2 {
  $labPath = Join-Path $RepoRoot "experiments\distributed_lab.json"
  if (-not (Test-Path $labPath)) {
    throw "FATAL: missing $labPath — copy experiments\distributed_lab.example.json and set ssh_host / controller_host. No silent fallback to local 4-Chrome."
  }
  $lab = Get-Content -Raw $labPath | ConvertFrom-Json
  $login = "$($lab.ssh_user)@$($lab.ssh_host)"
  $port = if ($lab.ssh_port) { $lab.ssh_port } else { 22 }
  $key = if ($lab.ssh_key_path) { @("-i", $lab.ssh_key_path) } else { @() }
  & ssh @("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-p", "$port") @key $login "exit 0"
  if ($LASTEXITCODE -ne 0) {
    throw "FATAL: SSH to $login failed (exit $LASTEXITCODE). Fix keys/host; will not run local 4-user fallback."
  }
  Write-Host "SSH ok: $login" -ForegroundColor Green
  return $lab
}

function Assert-LastSummaryRowsPass([string]$CsvPath, [int]$ExpectRows) {
  if (-not (Test-Path $CsvPath)) { throw "FATAL: missing summary CSV $CsvPath" }
  $rows = Import-Csv $CsvPath
  if ($rows.Count -lt $ExpectRows) {
    throw "FATAL: $CsvPath has $($rows.Count) rows, expected at least $ExpectRows"
  }
  $tail = $rows | Select-Object -Last $ExpectRows
  foreach ($r in $tail) {
    if ($r.status -ne "PASS") {
      throw "FATAL: canary / gate row not PASS: method=$($r.method) scenario=$($r.scenario) status=$($r.status)"
    }
  }
}

function Invoke-DistributedCell([string]$Method, [string]$Scenario, [string]$Profile, [string]$Capture, [string]$Headless, [string]$Label) {
  Bump-Seq
  Write-Host "=== $Label (distributed) run_seq=$($env:VRC_RUN_SEQ) method=$Method scenario=$Scenario profile=$Profile ===" -ForegroundColor Cyan
  $env:VRC_METHODS = $Method
  $env:VRC_SCENARIOS = $Scenario
  $env:VRC_TRIALS = "1"
  $env:VRC_DELIVERY_PROFILE = $Profile
  if ($Profile -eq "origin_only") {
    $env:VRC_CDN_LABEL = "hpc"
  } elseif ($Profile -eq "static_cdn") {
    throw "FATAL: static_cdn removed (all-CDN = second server baseline). Use vrc_guided_hybrid."
  } elseif ($Profile -eq "vrc_guided_hybrid") {
    if (-not $env:VRC_CDN_LABEL) { $env:VRC_CDN_LABEL = "cdn1" }
  } else {
    throw "FATAL: unknown delivery profile '$Profile' — set Invoke-DistributedCell caller to assign VRC_CDN_LABEL explicitly."
  }
  $env:VRC_CAPTURE_MODE = $Capture
  $env:VRC_HEADLESS = $Headless
  Remove-Item Env:VRC_SINGLE_TRIAL -ErrorAction SilentlyContinue
  Push-Location $RepoRoot
  try {
    node experiments/run_experiment_distributed.mjs
    if ($LASTEXITCODE -ne 0) { throw "distributed runner exit $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null
Write-Host "VRC_RESULTS_ROOT=$ResultsRoot (distributed 2+2)" -ForegroundColor Green
$null = Test-SshWorker2

$pfCsv = Join-Path $ResultsRoot "summary\run_pass_fail.csv"

# H1–H4 canaries (stop on first failure)
Invoke-DistributedCell "Full" "nearby" "origin_only" "metrics_only" "true" "Canary H1"
Assert-LastSummaryRowsPass $pfCsv 1
$env:VRC_CDN_LABEL = "cdn1"
Invoke-DistributedCell "VRC" "nearby" "vrc_guided_hybrid" "metrics_only" "true" "Canary H2 hybrid cdn1"
Assert-LastSummaryRowsPass $pfCsv 2
$env:VRC_CDN_LABEL = "cdn2"
Invoke-DistributedCell "VRC" "nearby" "vrc_guided_hybrid" "metrics_only" "true" "Canary H3 hybrid cdn2"
Assert-LastSummaryRowsPass $pfCsv 3
$env:VRC_CDN_LABEL = "cdn1"
Invoke-DistributedCell "VRC" "nearby" "vrc_guided_hybrid" "sequential" "false" "Canary H4 visual"
Assert-LastSummaryRowsPass $pfCsv 4

$shotDir = Join-Path $ResultsRoot "screenshots"
$u0 = Get-ChildItem -Path $shotDir -Filter "*_u0.png" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($u0) {
  Copy-Item -LiteralPath $u0.FullName -Destination (Join-Path $ResultsRoot "fig1_demo_screenshot.png") -Force
  Write-Host "fig1_demo_screenshot.png <= $($u0.Name)" -ForegroundColor Green
} else {
  Write-Host "WARNING: no *_u0.png under $shotDir" -ForegroundColor Yellow
}

# 12-run mini (only after H1–H4 all PASS)
$beforeMini = (Import-Csv $pfCsv).Count
$miniMethods = @("Spark-MU", "VRC")
$miniDelivery = @(
  @{ profile = "origin_only"; label = "hpc" },
  @{ profile = "vrc_guided_hybrid"; label = "cdn1" },
  @{ profile = "vrc_guided_hybrid"; label = "cdn2" }
)
$scens = @("nearby", "divergent")
foreach ($dc in $miniDelivery) {
  if ($dc.label -eq "hpc") { $env:VRC_CDN_LABEL = "hpc" } else { $env:VRC_CDN_LABEL = $dc.label }
  foreach ($m in $miniMethods) {
    foreach ($sc in $scens) {
      Invoke-DistributedCell $m $sc $dc.profile "metrics_only" "true" "Mini $m $sc $($dc.profile) $($dc.label)"
    }
  }
}
$afterMini = (Import-Csv $pfCsv).Count
if (($afterMini - $beforeMini) -ne 12) {
  Write-Host "WARNING: expected 12 new summary rows after mini, got $($afterMini - $beforeMini)" -ForegroundColor Yellow
}

Write-Host "Done (distributed). Results: $ResultsRoot" -ForegroundColor Green
exit 0
