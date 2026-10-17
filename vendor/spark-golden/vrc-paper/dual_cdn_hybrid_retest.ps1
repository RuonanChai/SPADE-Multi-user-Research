# Dual-CDN distributed canaries + mini (reliability-focused orchestrator).
# Phase E debug: $env:VRC_DEBUG_MINIMAL='1' runs H1 + H2 only (optional H3 if CDN2 reachable).

$ErrorActionPreference = "Stop"
# Default on: keep running canaries/mini after a cell fails (set VRC_CONTINUE_ON_FAIL=0 to stop on first failure).
$ContinueOnFail = ($env:VRC_CONTINUE_ON_FAIL -ne "0")
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = $ScriptDir
$DefaultCdn1 = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
$DefaultHpc = "http://10.120.17.176:8090/examples"

$env:VRC_DISTRIBUTED = "true"
$env:VRC_WORKER_ID = "worker1"
$env:VRC_HOST_IP = if ($env:VRC_CONTROLLER_HOST) { $env:VRC_CONTROLLER_HOST } else { "10.4.158.143" }
$env:VRC_USER_INDICES = "0,1"
$env:VRC_SUMMARY_APPEND = "1"
$env:VRC_HOT_THRESHOLD = "2"
$env:VRC_CDN_FALLBACK_TO_HPC = "true"
if (-not $env:VRC_HPC_ASSET_BASE) { $env:VRC_HPC_ASSET_BASE = $DefaultHpc }
if (-not $env:VRC_CDN_ASSET_BASE) { $env:VRC_CDN_ASSET_BASE = $DefaultCdn1 }

$LabJson = Join-Path $RepoRoot "experiments\distributed_lab.json"
if (Test-Path $LabJson) {
  try {
    $lab = Get-Content -Raw -Encoding UTF8 $LabJson | ConvertFrom-Json
    if (-not $env:VRC_CDN2_ASSET_BASE -or -not $env:VRC_CDN2_ASSET_BASE.Trim()) {
      $b = [string]$lab.cdn2_asset_base
      if ($b -and $b.Trim()) { $env:VRC_CDN2_ASSET_BASE = $b.Trim().TrimEnd("/") }
    }
    if (-not $env:VRC_CDN2_OBJECT_PATH -or -not $env:VRC_CDN2_OBJECT_PATH.Trim()) {
      $p = [string]$lab.cdn2_object_path
      if ($p -and $p.Trim()) { $env:VRC_CDN2_OBJECT_PATH = $p.Trim().TrimStart("/") }
    }
    if (-not $env:VRC_CDN2_OBJECT_PATH_HOBBITON -or -not $env:VRC_CDN2_OBJECT_PATH_HOBBITON.Trim()) {
      $p = [string]$lab.cdn2_object_path_hobbiton
      if ($p -and $p.Trim()) { $env:VRC_CDN2_OBJECT_PATH_HOBBITON = $p.Trim().TrimStart("/") }
    }
  } catch {
    Write-Warning "Could not read CDN2 from distributed_lab.json: $($_.Exception.Message)"
  }
}

$DebugMinimal = ($env:VRC_DEBUG_MINIMAL -eq "1")
$NeedCdn2 = -not $DebugMinimal
if ($NeedCdn2 -and (-not $env:VRC_CDN2_ASSET_BASE -or -not $env:VRC_CDN2_ASSET_BASE.Trim())) {
  throw "FATAL: Set VRC_CDN2_ASSET_BASE (or distributed_lab.json cdn2_asset_base). Use VRC_DEBUG_MINIMAL=1 for H1+H2 only."
}
if ($env:VRC_CDN2_ASSET_BASE -and $env:VRC_CDN_ASSET_BASE -and ($env:VRC_CDN2_ASSET_BASE.Trim().TrimEnd("/") -eq $env:VRC_CDN_ASSET_BASE.Trim().TrimEnd("/"))) {
  throw "FATAL: VRC_CDN2_ASSET_BASE must not equal VRC_CDN_ASSET_BASE."
}

$ResultsRoot = if ($env:VRC_RESULTS_ROOT -and $env:VRC_RESULTS_ROOT.Trim()) {
  $env:VRC_RESULTS_ROOT.Trim()
} else {
  Join-Path $RepoRoot ("results_dualcdn_debug_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
}
$env:VRC_RESULTS_ROOT = $ResultsRoot
New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ResultsRoot "summary") | Out-Null

$CDN1 = $env:VRC_CDN_ASSET_BASE.Trim().TrimEnd("/")
$CDN2 = if ($env:VRC_CDN2_ASSET_BASE) { $env:VRC_CDN2_ASSET_BASE.Trim().TrimEnd("/") } else { "" }

if (([string]::IsNullOrWhiteSpace($env:VRC_DISTRIBUTED_PUSH_TO_WORKER2)) -and ([string]::IsNullOrWhiteSpace($env:VRC_DISTRIBUTED_PUSH_VRC_PAPER))) {
  $env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "1"
}

function Bump-Seq {
  if (-not $script:DualRunSeq) { $script:DualRunSeq = 0 }
  $script:DualRunSeq++
  $env:VRC_RUN_SEQ = "$script:DualRunSeq"
}

function As-RowArray($Items) {
  if ($null -eq $Items) { return @() }
  return @($Items)
}

function Get-RowCount($Items) {
  return (As-RowArray $Items).Count
}

function Get-PfRows([string]$CsvPath) {
  if (-not (Test-Path $CsvPath)) {
    return @()
  }
  $abs = (Resolve-Path $CsvPath).Path
  $json = & node (Join-Path $RepoRoot "experiments\summary_csv.mjs") read $abs 2>&1
  if ($LASTEXITCODE -ne 0) {
    $preview = ""
    try { $preview = (Get-Content -LiteralPath $abs -TotalCount 3 -Raw -ErrorAction SilentlyContinue) } catch {}
    throw "FATAL: summary_csv read failed for $abs exit=$LASTEXITCODE output=$json preview=$preview"
  }
  if ([string]::IsNullOrWhiteSpace($json)) { return @() }
  $parsed = $json | ConvertFrom-Json
  if ($null -eq $parsed) { return @() }
  return ,@(As-RowArray $parsed)
}

function Diagnose-PfCsv([string]$CsvPath, [string]$Context) {
  if (-not (Test-Path $CsvPath)) {
    throw "FATAL [$Context]: run_pass_fail.csv missing at $CsvPath (VRC_RESULTS_ROOT=$ResultsRoot)"
  }
  $fi = Get-Item $CsvPath
  if ($fi.Length -eq 0) {
    throw "FATAL [$Context]: run_pass_fail.csv is 0 bytes at $CsvPath"
  }
  $head = (Get-Content -LiteralPath $CsvPath -TotalCount 2 -Encoding UTF8) -join " | "
  Write-Host "[$Context] run_pass_fail.csv size=$($fi.Length) head=$head"
}

function Invoke-PreflightProfile([string]$Profile) {
  Write-Host "=== preflight profile=$Profile ===" -ForegroundColor Cyan
  Push-Location $RepoRoot
  try {
    & node experiments/dual_cdn_preflight.mjs --assets-only --require-profile $Profile
    $code = $LASTEXITCODE
    if ($code -eq 0) { return @{ ok = $true; skip = $false } }
    if ($code -eq 3 -and $Profile -eq "dual_cdn") {
      Write-Warning "[preflight] dual_cdn CDN2 unreachable → SKIP_EXTERNAL_UNREACHABLE"
      return @{ ok = $false; skip = $true; reason = "SKIP_EXTERNAL_UNREACHABLE" }
    }
    if ($ContinueOnFail) {
      Write-Warning "preflight profile=$Profile failed exit=$code — continue"
      return @{ ok = $false; skip = $false; reason = "PREFLIGHT_FAIL_$code" }
    }
    throw "preflight profile=$Profile failed exit=$code"
  } finally {
    Pop-Location
  }
}

function Invoke-DistributedCanary([string]$Method, [string]$Scenario, [string]$Profile, [string]$CdnLabel, [string]$CdnBasePrimary, [string]$Capture, [string]$Headless, [string]$CanaryId, [string]$Label, [string]$PreflightProfile) {
  Bump-Seq
  Write-Host "=== $Label canary=$CanaryId run_seq=$($env:VRC_RUN_SEQ) preflight=$PreflightProfile ===" -ForegroundColor Cyan

  if ($PreflightProfile) {
    $pf = Invoke-PreflightProfile $PreflightProfile
    if ($pf.ok -eq $false -and -not $pf.skip) {
      Write-Warning "[$Label] preflight failed: $($pf.reason) — skip trial"
      return $false
    }
    if ($pf.skip) {
      $pfPath = Join-Path $ResultsRoot "summary\run_pass_fail.csv"
      $skipRow = @{
        run = [int]$env:VRC_RUN_SEQ
        method = $Method
        scenario = $Scenario
        trial = 0
        delivery_profile = $Profile
        canary = $CanaryId
        status = "SKIP_EXTERNAL_UNREACHABLE"
        fail_reason = $pf.reason
        session_id = ""
        result_dir = ""
      }
      $tmp = Join-Path $env:TEMP "vrc_skip_row_$([Guid]::NewGuid().ToString('N')).json"
      $skipRow | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8
      $pfCsv = Join-Path $ResultsRoot "summary\run_pass_fail.csv"
      & node (Join-Path $RepoRoot "experiments\summary_csv.mjs") append-row $pfCsv $tmp
      if ($LASTEXITCODE -ne 0) { throw "append-row SKIP failed" }
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      Write-Warning "[$Label] skipped: $($pf.reason)"
      return
    }
  }

  $env:VRC_METHODS = $Method
  $env:VRC_SCENARIOS = $Scenario
  $env:VRC_TRIALS = "1"
  $env:VRC_DELIVERY_PROFILE = $Profile
  $env:VRC_CDN_ASSET_BASE = $CdnBasePrimary
  if ($CdnLabel -and $CdnLabel.Trim().Length -gt 0) {
    $env:VRC_CDN_LABEL = $CdnLabel.Trim()
  } elseif ($Profile -eq "origin_only") {
    $env:VRC_CDN_LABEL = "hpc"
  } else {
    throw "FATAL: Invoke-DistributedCanary requires explicit CdnLabel for profile=$Profile"
  }
  $env:VRC_CAPTURE_MODE = $Capture
  $env:VRC_HEADLESS = $Headless
  $env:VRC_CANARY_RULE = $CanaryId
  Remove-Item Env:VRC_SINGLE_TRIAL -ErrorAction SilentlyContinue

  Push-Location $RepoRoot
  try {
    node experiments/run_experiment_distributed.mjs
    if ($LASTEXITCODE -ne 0) {
      if ($ContinueOnFail) {
        Write-Warning "[$Label] distributed exit $LASTEXITCODE — continue (VRC_CONTINUE_ON_FAIL)"
        return $false
      }
      throw "distributed exit $LASTEXITCODE ($Label)"
    }
    return $true
  } finally {
    Pop-Location
  }
}

function Try-Assert-LastPass([string]$CsvPath, [int]$N) {
  try {
    Assert-LastPass $CsvPath $N
    return $true
  } catch {
    if ($ContinueOnFail) {
      Write-Warning "[Assert-LastPass] $($_.Exception.Message)"
      return $false
    }
    throw
  }
}

function Try-Assert-LastTrialDataOk([string]$CsvPath, [switch]$ConnectivityBaseline) {
  try {
    Assert-LastTrialDataOk $CsvPath -ConnectivityBaseline:$ConnectivityBaseline
    return $true
  } catch {
    if ($ContinueOnFail) {
      Write-Warning "[Assert-LastTrialDataOk] $($_.Exception.Message)"
      return $false
    }
    throw
  }
}

function Assert-LastPass([string]$CsvPath, [int]$N) {
  Diagnose-PfCsv $CsvPath "Assert-LastPass"
  $rows = Get-PfRows $CsvPath
  if ((Get-RowCount $rows) -lt $N) {
    throw "FATAL: $CsvPath has $(Get-RowCount $rows) data rows, need >=$N (Import-Csv/summary_csv read). VRC_RESULTS_ROOT=$ResultsRoot"
  }
  $tail = @($rows | Select-Object -Last $N)
  foreach ($r in $tail) {
    if ($r.status -ne "PASS") {
      throw "FATAL: expected PASS at tail row status=$($r.status) method=$($r.method) canary=$($r.canary) fail_reason=$($r.fail_reason)"
    }
  }
}

function Assert-LastTrialDataOk([string]$CsvPath, [switch]$ConnectivityBaseline) {
  if ($env:VRC_SKIP_HARD_GATE -eq "1") { return }
  Diagnose-PfCsv $CsvPath "Assert-LastTrialDataOk"
  $rows = Get-PfRows $CsvPath
  if ((Get-RowCount $rows) -lt 1) {
    throw "FATAL: empty run_pass_fail.csv after distributed run (path=$CsvPath). Node may have logged Done: PASS but CSV verify failed — check summary_csv.mjs output."
  }
  $last = $rows | Select-Object -Last 1
  if ($last.status -eq "SKIP_EXTERNAL_UNREACHABLE") {
    Write-Warning "Last row SKIP_EXTERNAL_UNREACHABLE — skipping hard gate"
    return
  }
  if ($last.status -ne "PASS") {
    throw "FATAL: last trial FAIL status=$($last.status) session=$($last.session_id) fail_reason=$($last.fail_reason)"
  }
  if ($ConnectivityBaseline) {
    Write-Host "[gate] origin_only connectivity baseline — skip strict streaming-lod data_validation"
    return
  }
  Push-Location $RepoRoot
  try {
    node experiments/distributed_hard_gate.mjs --validate-session $last.session_id
    if ($LASTEXITCODE -ne 0) { throw "hard-gate session validation failed for $($last.session_id)" }
  } finally {
    Pop-Location
  }
}

function Find-OriginOnlyPass([string]$CsvPath) {
  Diagnose-PfCsv $CsvPath "resume"
  $rows = Get-PfRows $CsvPath
  $hits = @($rows | Where-Object {
    $_.delivery_profile -eq "origin_only" -and $_.status -eq "PASS"
  })
  return ,@(As-RowArray $hits)
}

Write-Host "VRC_RESULTS_ROOT=$ResultsRoot" -ForegroundColor Green

if ($env:VRC_SKIP_HARD_GATE -eq "1") {
  Write-Warning "[skip] VRC_SKIP_HARD_GATE=1 — Worker2/scp/manifest gate skipped (debug only)"
} else {
  $env:VRC_PREFLIGHT_PROFILE = "cdn1"
  Push-Location $RepoRoot
  try {
    Write-Host "=== distributed hard gate (pre-run, profile=cdn1) ===" -ForegroundColor Cyan
    node experiments/distributed_hard_gate.mjs --pre-run
    if ($LASTEXITCODE -ne 0) { throw "distributed_hard_gate --pre-run failed exit=$LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "0"
  $env:VRC_DISTRIBUTED_PUSH_VRC_PAPER = "0"
}

$pf = Join-Path $ResultsRoot "summary\run_pass_fail.csv"

# H1 origin_only — HPC + SSH only
if ($env:VRC_RESUME_SKIP_H1 -eq "1") {
  Write-Host "[resume] VRC_RESUME_SKIP_H1=1" -ForegroundColor Yellow
  $h1rows = @(Find-OriginOnlyPass $pf)
  if ((Get-RowCount $h1rows) -lt 1) {
    $all = Get-PfRows $pf
    $diag = ($all | ForEach-Object { "$($_.delivery_profile)/$($_.status)/$($_.pass)" }) -join "; "
    throw "FATAL: VRC_RESUME_SKIP_H1 but no origin_only PASS in $pf (rows=$(Get-RowCount $all) profiles=[$diag])"
  }
  Write-Host "[resume] reusing H1 PASS session=$($h1rows[-1].session_id)"
} else {
  $null = Invoke-DistributedCanary "Full" "nearby" "origin_only" "hpc" $CDN1 "metrics_only" "true" "H1" "H1 origin_only" "origin_only"
  $null = Try-Assert-LastPass $pf 1
  $null = Try-Assert-LastTrialDataOk $pf -ConnectivityBaseline
}

# H2 cdn1 hybrid
if ($env:VRC_RESUME_SKIP_H2 -eq "1") {
  Write-Host "[resume] VRC_RESUME_SKIP_H2=1" -ForegroundColor Yellow
  $h2rows = @(Get-PfRows $pf | Where-Object {
    $_.canary -eq "H2" -and $_.status -eq "PASS"
  })
  if ((Get-RowCount $h2rows) -lt 1) {
    throw "FATAL: VRC_RESUME_SKIP_H2 but no H2 PASS in $pf"
  }
  Write-Host "[resume] reusing H2 PASS session=$($h2rows[-1].session_id)"
} else {
  $null = Invoke-DistributedCanary "VRC" "nearby" "vrc_guided_hybrid" "cdn1" $CDN1 "metrics_only" "true" "H2" "H2 vrc_hybrid_cdn1" "cdn1"
  $null = Try-Assert-LastPass $pf 2
  $null = Try-Assert-LastTrialDataOk $pf
}

if (-not $DebugMinimal) {
  # H3 cdn2
  $null = Invoke-DistributedCanary "VRC" "nearby" "vrc_guided_hybrid" "cdn2" $CDN2 "metrics_only" "true" "H3" "H3 vrc_hybrid_cdn2" "dual_cdn"
  $rows = Get-PfRows $pf
  $last = $rows | Select-Object -Last 1
  if ($last.status -eq "SKIP_EXTERNAL_UNREACHABLE") {
    Write-Warning "H3 skipped (CDN2 unreachable) — continuing"
  } else {
    $null = Try-Assert-LastPass $pf 3
    $null = Try-Assert-LastTrialDataOk $pf
  }

  # H4 visual (sequential, headful) — validates screenshots + VRC path
  $null = Invoke-DistributedCanary "VRC" "nearby" "vrc_guided_hybrid" "cdn1" $CDN1 "sequential" "false" "H4" "H4 vrc_visual_cdn1" "cdn1"
  $null = Try-Assert-LastPass $pf 4
  $null = Try-Assert-LastTrialDataOk $pf

  $shotDir = Join-Path $ResultsRoot "screenshots"
  $u0 = Get-ChildItem -Path $shotDir -Filter "*_u0.png" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($u0) {
    Copy-Item -LiteralPath $u0.FullName -Destination (Join-Path $ResultsRoot "fig1_demo_screenshot.png") -Force
    Write-Host "fig1_demo_screenshot.png <= $($u0.Name)" -ForegroundColor Green
  } else {
    Write-Warning "H4: no *_u0.png under $shotDir"
  }

  # 12-run mini matrix (Spark-MU + VRC × nearby/divergent × 3 delivery profiles)
  Write-Host "=== mini matrix (12 runs) ===" -ForegroundColor Cyan
  $miniMethods = @("Spark-MU", "VRC")
  $miniDelivery = @(
    @{ profile = "origin_only"; label = "hpc"; preflight = "origin_only" },
    @{ profile = "vrc_guided_hybrid"; label = "cdn1"; preflight = "cdn1" },
    @{ profile = "vrc_guided_hybrid"; label = "cdn2"; preflight = "dual_cdn" }
  )
  $scens = @("nearby", "divergent")
  foreach ($dc in $miniDelivery) {
    foreach ($m in $miniMethods) {
      foreach ($sc in $scens) {
        $cdnBase = if ($dc.label -eq "cdn2") { $CDN2 } else { $CDN1 }
        $null = Invoke-DistributedCanary $m $sc $dc.profile $dc.label $cdnBase "metrics_only" "true" "mini" "Mini $m $sc $($dc.profile) $($dc.label)" $dc.preflight
      }
    }
  }
} else {
  Write-Host "[VRC_DEBUG_MINIMAL=1] skip H3/H4/mini matrix" -ForegroundColor Yellow
}

Diagnose-PfCsv $pf "final"
& node (Join-Path $RepoRoot "experiments\summary_csv.mjs") verify $pf 1
if ($LASTEXITCODE -ne 0) { throw "final run_pass_fail.csv verify failed" }

$allRows = Get-PfRows $pf
$passN = @($allRows | Where-Object { $_.status -eq "PASS" }).Count
$failN = @($allRows | Where-Object { $_.status -ne "PASS" }).Count
Write-Host "Summary: PASS=$passN FAIL/skip=$failN rows=$(Get-RowCount $allRows)" -ForegroundColor $(if ($failN -eq 0) { "Green" } else { "Yellow" })
Write-Host "Done. Results: $ResultsRoot" -ForegroundColor Green
Write-Host "Artifacts: summary/run_pass_fail.csv, summary/endpoint_audit.csv, raw/*/validation_report.json, raw/*/remote_debug/" -ForegroundColor Green
if ($failN -gt 0 -and -not $ContinueOnFail) { exit 1 }
if ($failN -gt 0) { exit 2 }
exit 0
