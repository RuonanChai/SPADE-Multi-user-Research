# run_master.ps1 — autonomous master wrapper for VRC Web3DGS paper experiment.
# Sequence:
#   1. Phase 0 cleanup
#   2. dual_cdn_hybrid_retest.ps1 (H1..H6 distributed canaries + 20-run mini, dual CDN, dual machine)
#   3. run_autonomous_pipeline_detached.ps1 with VRC_RUN_FULL_PIPELINE=1 (canary1A/1B/2/3 + prefull + full 72-run)
#   4. analysis/run_analysis.mjs (aggregate + validate_canary + figures + report)
#   5. Copy final artifacts under artifacts/auto_run/<results-name>/
# Writes STATE.json, ERR.log, OUT.log under artifacts/auto_run/.

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VrcPaper  = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$RepoRoot  = Split-Path -Parent $VrcPaper

$AutoRoot   = $ScriptDir
$Ts         = Get-Date -Format "yyyyMMdd_HHmmss"
$ResultsDir = Join-Path $AutoRoot "results_$Ts"
$LogDir     = Join-Path $AutoRoot "logs"
$StateFile  = Join-Path $AutoRoot "STATE.json"
$NextFile   = Join-Path $AutoRoot "NEXT_ACTION.md"
$DebugFile  = Join-Path $AutoRoot "DEBUG_LOG.md"
$MasterOut  = Join-Path $LogDir "master_${Ts}.out.log"
$MasterErr  = Join-Path $LogDir "master_${Ts}.err.log"

New-Item -ItemType Directory -Force -Path $AutoRoot, $ResultsDir, $LogDir | Out-Null

function W([string]$m) {
    $line = "[$([DateTime]::Now.ToString('s'))] $m"
    Write-Host $line
    Add-Content -Path $MasterOut -Value $line
}
function WErr([string]$m) {
    $line = "[$([DateTime]::Now.ToString('s'))] [ERR] $m"
    Write-Host $line -ForegroundColor Red
    Add-Content -Path $MasterErr -Value $line
    Add-Content -Path $MasterOut -Value $line
}
function Save-State([hashtable]$patch) {
    $obj = @{}
    if (Test-Path $StateFile) {
        try { $obj = Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } catch { $obj = @{} }
    }
    foreach ($k in $patch.Keys) { $obj[$k] = $patch[$k] }
    $obj["updated"] = [DateTime]::Now.ToString("s")
    ($obj | ConvertTo-Json -Depth 8) | Set-Content -Path $StateFile
}
function Write-Next([string]$t) { Set-Content -Path $NextFile -Value $t }
function Append-Debug([string]$phase, [string]$m) {
    Add-Content -Path $DebugFile -Value "## $([DateTime]::Now.ToString('s')) [$phase] $m"
}
function Kill-VrcProcs() {
    W "[cleanup] killing stale VRC node/chrome processes"
    try {
        Get-CimInstance Win32_Process | Where-Object {
            ($_.Name -match "node.exe|chrome.exe|chromium.exe") -and
            ($_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment|run_experiment_distributed|sync_server")
        } | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
    } catch { WErr "[cleanup] non-fatal: $_" }
}

W "=== AUTO_MASTER START pid=$PID ==="
W "AutoRoot=$AutoRoot"
W "ResultsDir=$ResultsDir"
W "VrcPaper=$VrcPaper"
W "RepoRoot=$RepoRoot"

# ── Env (dual CDN, dual machine) ─────────────────────────────────────────────
$env:VRC_RESULTS_ROOT             = $ResultsDir
$env:VRC_HPC_ASSET_BASE           = if ($env:VRC_HPC_ASSET_BASE) { $env:VRC_HPC_ASSET_BASE } else { "http://10.120.17.176:8090/examples" }
$env:VRC_CDN_ASSET_BASE           = if ($env:VRC_CDN_ASSET_BASE) { $env:VRC_CDN_ASSET_BASE } else { "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev" }
$env:VRC_CDN2_ASSET_BASE          = if ($env:VRC_CDN2_ASSET_BASE) { $env:VRC_CDN2_ASSET_BASE } else { "https://storage.googleapis.com/forge-dev-public" }
$env:VRC_CDN2_OBJECT_PATH         = if ($env:VRC_CDN2_OBJECT_PATH) { $env:VRC_CDN2_OBJECT_PATH } else { "asundqui/rad/260217/coit-40m-sh1-lod.rad" }
$env:VRC_CDN2_OBJECT_PATH_HOBBITON= if ($env:VRC_CDN2_OBJECT_PATH_HOBBITON) { $env:VRC_CDN2_OBJECT_PATH_HOBBITON } else { "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad" }
$env:VRC_DISTRIBUTED              = "true"
$env:VRC_HEADLESS                 = "true"

Save-State @{
    auto_root=$AutoRoot; results_dir=$ResultsDir; pid=$PID; phase="start";
    cdn1=$env:VRC_CDN_ASSET_BASE; cdn2=$env:VRC_CDN2_ASSET_BASE; halted=$false
}
Write-Next "Master autonomous pipeline running (pid=$PID). See $MasterOut."

# ── Phase 0: cleanup ─────────────────────────────────────────────────────────
Save-State @{ phase="phase0_cleanup" }
Kill-VrcProcs
Start-Sleep -Seconds 2
Kill-VrcProcs

# ── Phase 1: dual_cdn_hybrid_retest.ps1 (H1..H6 + mini 20) ───────────────────
function Invoke-Canaries-Once([int]$attempt) {
    Save-State @{ phase="canaries_h1_h6_mini_attempt_$attempt" }
    $script = Join-Path $VrcPaper "dual_cdn_hybrid_retest.ps1"
    $hOut = Join-Path $LogDir "canaries_attempt${attempt}.out.log"
    $hErr = Join-Path $LogDir "canaries_attempt${attempt}.err.log"
    W "[canaries] attempt=$attempt running $script (out=$hOut)"
    $proc = Start-Process powershell -ArgumentList @(
        "-NoProfile","-ExecutionPolicy","Bypass","-File", $script
    ) -WorkingDirectory $VrcPaper -RedirectStandardOutput $hOut -RedirectStandardError $hErr -WindowStyle Hidden -PassThru
    Save-State @{ canary_pid=$proc.Id; canary_log=$hOut }
    $deadline = (Get-Date).AddMinutes(360)
    while ($true) {
        $r = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if (-not $r) { break }
        if ((Get-Date) -gt $deadline) {
            WErr "[canaries] timeout after 360 min, killing pid=$($proc.Id)"
            try { Stop-Process -Id $proc.Id -Force } catch {}
            Kill-VrcProcs
            return $false
        }
        Start-Sleep -Seconds 60
    }
    try { [void]$proc.WaitForExit(60000) } catch {}
    try { $proc.Refresh() } catch {}
    $code = $null
    try { $code = $proc.ExitCode } catch { $code = $null }
    W "[canaries] attempt=$attempt exit_code=$code"
    if ($code -ne 0) {
        Append-Debug "canaries" "attempt=$attempt exit=$code see $hErr"
        return $false
    }
    return $true
}

$canaryOk = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
    if (Invoke-Canaries-Once $attempt) {
        $canaryOk = $true
        break
    }
    WErr "[canaries] attempt=$attempt failed; cleaning up and retrying"
    Kill-VrcProcs
    Start-Sleep -Seconds 30
    Kill-VrcProcs
}

if (-not $canaryOk) {
    Save-State @{ phase="canaries_failed_permanent"; halted=$true }
    Write-Next "Canary chain (H1..H6 + mini) failed after 3 attempts. Inspect logs/canaries_attempt*.err.log and $MasterOut."
    WErr "=== HALT canaries failed after 3 attempts ==="
    exit 1
}

W "=== H1..H6 + mini PASS — proceeding to full 72-run pipeline ==="
Save-State @{ phase="canaries_pass" }

# ── Phase 2: run_autonomous_pipeline_detached.ps1 with full pipeline ─────────
$env:VRC_RUN_FULL_PIPELINE = "1"
$env:VRC_USE_DISTRIBUTED   = "1"
# Reuse same VRC_RESULTS_ROOT so canary + full data live in one tree.

function Invoke-FullPipeline([int]$attempt) {
    Save-State @{ phase="full_pipeline_attempt_$attempt" }
    $script = Join-Path $VrcPaper "run_autonomous_pipeline_detached.ps1"
    $fOut = Join-Path $LogDir "fullpipe_attempt${attempt}.out.log"
    $fErr = Join-Path $LogDir "fullpipe_attempt${attempt}.err.log"
    W "[fullpipe] attempt=$attempt running $script"
    $proc = Start-Process powershell -ArgumentList @(
        "-NoProfile","-ExecutionPolicy","Bypass","-File", $script
    ) -WorkingDirectory $VrcPaper -RedirectStandardOutput $fOut -RedirectStandardError $fErr -WindowStyle Hidden -PassThru
    Save-State @{ fullpipe_pid=$proc.Id; fullpipe_log=$fOut }
    $deadline = (Get-Date).AddHours(36)
    while ($true) {
        $r = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if (-not $r) { break }
        if ((Get-Date) -gt $deadline) {
            WErr "[fullpipe] timeout after 36h, killing pid=$($proc.Id)"
            try { Stop-Process -Id $proc.Id -Force } catch {}
            Kill-VrcProcs
            return $false
        }
        Start-Sleep -Seconds 120
    }
    try { [void]$proc.WaitForExit(120000) } catch {}
    try { $proc.Refresh() } catch {}
    $code = $null
    try { $code = $proc.ExitCode } catch { $code = $null }
    W "[fullpipe] attempt=$attempt exit_code=$code"
    if ($code -ne 0) {
        Append-Debug "fullpipe" "attempt=$attempt exit=$code see $fErr"
        return $false
    }
    return $true
}

$fullOk = $false
for ($attempt = 1; $attempt -le 2; $attempt++) {
    if (Invoke-FullPipeline $attempt) {
        $fullOk = $true
        break
    }
    WErr "[fullpipe] attempt=$attempt failed; cleaning + retrying"
    Kill-VrcProcs
    Start-Sleep -Seconds 60
}

if (-not $fullOk) {
    Save-State @{ phase="fullpipe_failed"; halted=$true }
    Write-Next "Full pipeline failed after retries. Inspect logs/fullpipe_attempt*.err.log."
    WErr "=== HALT fullpipe failed ==="
    # Continue to analysis even if full pipeline didn't fully complete — partial data may still be useful.
}

# ── Phase 3: analysis (aggregate + validate_canary + figures + report) ───────
Save-State @{ phase="analysis" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

$analysisOut = Join-Path $LogDir "analysis.out.log"
$analysisErr = Join-Path $LogDir "analysis.err.log"
W "[analysis] running run_analysis.mjs against $ResultsDir"
$proc = Start-Process $node -ArgumentList @("`"$(Join-Path $VrcPaper 'analysis/run_analysis.mjs')`"") `
    -WorkingDirectory $VrcPaper `
    -RedirectStandardOutput $analysisOut -RedirectStandardError $analysisErr `
    -WindowStyle Hidden -PassThru
$proc.WaitForExit()
$analysisCode = $proc.ExitCode
W "[analysis] mjs exit=$analysisCode"

# also try analyze.py if available
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if ($python) {
    $pyOut = Join-Path $LogDir "analyze_py.out.log"
    $pyErr = Join-Path $LogDir "analyze_py.err.log"
    W "[analysis] running analyze.py"
    $pyProc = Start-Process $python -ArgumentList @("`"$(Join-Path $VrcPaper 'analysis/analyze.py')`"") `
        -WorkingDirectory $VrcPaper `
        -RedirectStandardOutput $pyOut -RedirectStandardError $pyErr `
        -WindowStyle Hidden -PassThru
    $pyProc.WaitForExit()
    W "[analysis] analyze.py exit=$($pyProc.ExitCode)"
}

# also call validate_canary.mjs producing canary_validation.csv directly
$cvOut = Join-Path $LogDir "validate_canary.out.log"
$cvErr = Join-Path $LogDir "validate_canary.err.log"
$cvProc = Start-Process $node -ArgumentList @(
    "`"$(Join-Path $VrcPaper 'analysis/validate_canary.mjs')`"",
    "--results-root", "`"$ResultsDir`""
) -WorkingDirectory $VrcPaper `
    -RedirectStandardOutput $cvOut -RedirectStandardError $cvErr `
    -WindowStyle Hidden -PassThru
$cvProc.WaitForExit()
W "[analysis] validate_canary.mjs exit=$($cvProc.ExitCode)"

# ── Phase 4: artifact verification ───────────────────────────────────────────
Save-State @{ phase="verify_artifacts" }
$summaryDir = Join-Path $ResultsDir "summary"
$figsDir    = Join-Path $ResultsDir "figures"
$finalReport= Join-Path $ResultsDir "final_report.md"

$artifactStatus = @{
    final_report_md         = (Test-Path $finalReport)
    metrics_summary_csv     = (Test-Path (Join-Path $summaryDir "metrics_summary.csv"))
    per_run_metrics_csv     = (Test-Path (Join-Path $summaryDir "per_run_metrics.csv"))
    per_client_metrics_csv  = (Test-Path (Join-Path $summaryDir "per_client_metrics.csv"))
    canary_validation_csv   = (Test-Path (Join-Path $summaryDir "canary_validation.csv"))
    fig1_demo_screenshot    = (Test-Path (Join-Path $figsDir "fig1_demo_screenshot.png"))
}
$artifactStatus.GetEnumerator() | ForEach-Object { W "[verify] $($_.Key) = $($_.Value)" }

$pass = ($artifactStatus.Values | Where-Object { -not $_ }).Count -eq 0
Save-State @{ phase="done"; halted=$false; finished_at=[DateTime]::Now.ToString("s"); artifacts=$artifactStatus; pass=$pass }
Write-Next "Pipeline finished. pass=$pass. See STATE.json + $finalReport (if present)."
W "=== AUTO_MASTER DONE pass=$pass ==="

if ($pass) { exit 0 } else { exit 2 }
