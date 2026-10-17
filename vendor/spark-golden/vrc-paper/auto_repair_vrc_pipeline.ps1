# Log-driven repair loop (max 5 rounds): minimal distributed canary only — no 72-run.
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Kill-StaleVrc {
    try {
        Get-CimInstance Win32_Process | Where-Object {
            ($_.Name -match "node.exe|chrome.exe|chromium.exe") -and
            ($_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment")
        } | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
    } catch {}
}

function Get-LatestLog([string]$root, [string]$pattern) {
    $dir = Join-Path $root "runner_logs"
    if (-not (Test-Path $dir)) { return $null }
    $hits = @(Get-ChildItem -Path (Join-Path $dir $pattern) -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($hits.Count -gt 0) { return $hits[0].FullName }
    return $null
}

function Classify-Failure([string]$resultsRoot) {
    $log = Get-LatestLog $resultsRoot "canary2_full_*.out.log"
    if (-not $log) { $log = Get-LatestLog $resultsRoot "canary1a_metrics_*.out.log" }
    $blob = ""
    if ($log -and (Test-Path $log)) { $blob = (Get-Content $log -Tail 300 -ErrorAction SilentlyContinue) -join "`n" }

    if ($blob -match 'VRC_WORKER_ID.*missing|VRC_HOST_IP.*missing|ENV_MISSING') { return "ENV_MISSING" }
    if ($blob -match 'scp pull FAILED|No such file or directory|REMOTE_SHARD_LAUNCH_OR_OUTPUT') { return "SCP_PULL_FAILED" }
    if ($blob -match 'REMOTE_SHARD_FAILED_EXIT|REMOTE shard failed exit') { return "REMOTE_SHARD_EXIT_NONZERO" }
    if ($blob -match 'connect:\s*u[01]' -and $blob -notmatch 'connect:\s*u2') { return "NO_CONNECT_REMOTE_USERS" }
    if ($blob -match 'worker dir missing|_shardwork_.*_worker') { return "REMOTE_SHARD_NO_OUTPUT_DIR" }

    $pf = Join-Path $resultsRoot "summary\run_pass_fail.csv"
    if (-not (Test-Path $pf)) { return "RUN_PASS_FAIL_EMPTY" }
    $rows = @(Import-Csv $pf -ErrorAction SilentlyContinue)
    if ($rows.Count -lt 1) { return "RUN_PASS_FAIL_EMPTY" }
    $r = $rows[-1]
    if ($r.status -ne "PASS") {
        $fr = [string]$r.fail_reason
        if ($fr -match 'REMOTE') { return "REMOTE_SHARD_EXIT_NONZERO" }
        return "RUN_PASS_FAIL_NOT_PASS"
    }

    $pcm = Join-Path $resultsRoot "summary\per_client_metrics.csv"
    if (-not (Test-Path $pcm)) { return "RUN_PASS_FAIL_EMPTY" }
    $pm = @(Import-Csv $pcm)
    $sid = [string]$r.session_id
    $users = @($pm | Where-Object { $_.session_id -eq $sid })
    if ($users.Count -lt 4) { return "NO_CONNECT_REMOTE_USERS" }
    foreach ($u in $users) {
        if ([string]$u.metrics_source -match 'no_chunk_timing') { return "NO_CHUNK_TIMING" }
        $cdn = 0.0; $hpc = 0.0
        try { $cdn = [double]$u.cdn_bytes } catch { $cdn = 0 }
        try { $hpc = [double]$u.hpc_bytes } catch { $hpc = 0 }
        if ($cdn -le 0 -and $hpc -le 0) { return "CDN_NOT_USED" }
    }
    if ($blob -match 'VISUAL|screenshot|CDP|timeout') { return "VISUAL_TIMEOUT" }
    return "UNKNOWN"
}

function Write-RepairRoundMd([int]$round, [string]$resultsRoot, [string]$failType, [string[]]$changedFiles) {
    $md = Join-Path $resultsRoot "repair_round_$round.md"
    $log = Get-LatestLog $resultsRoot "canary2_full_*.out.log"
    $pf = Join-Path $resultsRoot "summary\run_pass_fail.csv"
    $diff = ""
    try { $diff = (git -C (Split-Path $ScriptDir -Parent) diff --stat 2>&1 | Out-String).Trim() } catch {}
    @"
# Repair round $round

- **failure_type**: $failType
- **evidence_log**: $log
- **changed_files**: $($changedFiles -join ', ')
- **git_diff_stat**:
```
$diff
```
"@ | Set-Content -LiteralPath $md -Encoding UTF8
}

$maxRounds = 5
if ($env:VRC_REPAIR_MAX_ROUNDS) { try { $maxRounds = [int]$env:VRC_REPAIR_MAX_ROUNDS } catch {} }

for ($round = 1; $round -le $maxRounds; $round++) {
    Write-Host "`n=== REPAIR ROUND $round / $maxRounds ===" -ForegroundColor Cyan
    Kill-StaleVrc
    Start-Sleep -Seconds 3
    Kill-StaleVrc

    $ts = Get-Date -Format "yyyyMMdd_HHmmss"
    $env:VRC_RESULTS_ROOT = Join-Path $ScriptDir "results_repair_${ts}_r$round"
    New-Item -ItemType Directory -Force -Path $env:VRC_RESULTS_ROOT | Out-Null

    Remove-Item Env:VRC_NO_HALT_ON_CANARY -ErrorAction SilentlyContinue
    Remove-Item Env:VRC_CONTINUE_ON_FAIL -ErrorAction SilentlyContinue
    Remove-Item Env:VRC_RUN_FULL_PIPELINE -ErrorAction SilentlyContinue
    # Repair loop targets remote shard; skip asset preflight hard gate (canary still runs SSH/remote).
    $env:VRC_SKIP_HARD_GATE = "1"
    $env:VRC_USE_DISTRIBUTED = "1"
    $env:VRC_DISTRIBUTED = "true"
    $env:VRC_CANARY_ONLY = "1"
    $env:VRC_CANARY_NAMES = "canary2_full"
    $env:VRC_METHODS = "Full"
    $env:VRC_SCENARIOS = "nearby"
    $env:VRC_TRIALS = "1"
    $env:VRC_DELIVERY_PROFILE = "vrc_guided_hybrid"
    $env:VRC_CDN_LABEL = "cdn1"
    $env:VRC_EXPECTED_USERS = "4"
    $env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "1"
    $env:VRC_HPC_ASSET_BASE = if ($env:VRC_HPC_ASSET_BASE) { $env:VRC_HPC_ASSET_BASE } else { "http://10.120.17.176:8090/examples" }
    $env:VRC_CDN_ASSET_BASE = if ($env:VRC_CDN_ASSET_BASE) { $env:VRC_CDN_ASSET_BASE } else { "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev" }
    $env:VRC_ADAPTIVE_VISUAL = "0"

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "run_autonomous_pipeline_detached.ps1")
    $exit = $LASTEXITCODE
    $failType = Classify-Failure $env:VRC_RESULTS_ROOT
    Write-RepairRoundMd $round $env:VRC_RESULTS_ROOT $failType @(
        "run_experiment_distributed.mjs",
        "run_experiment.mjs",
        "run_autonomous_pipeline_detached.ps1"
    )

    $pf = Join-Path $env:VRC_RESULTS_ROOT "summary\run_pass_fail.csv"
    $pfText = if (Test-Path $pf) { Get-Content $pf -Raw } else { "(missing)" }
    Write-Host "run_pass_fail.csv:`n$pfText"

    if ($exit -eq 0 -and $failType -eq "UNKNOWN") {
        Write-Host "READY_FOR_10_RUN" -ForegroundColor Green
        Write-Host "results=$($env:VRC_RESULTS_ROOT)"
        exit 0
    }
    Write-Host "Round $round failed: $failType (exit=$exit)" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}

Write-Host "BLOCKED_WITH_DIAGNOSTICS" -ForegroundColor Red
Write-Host "Inspect latest results_repair_* under $ScriptDir"
exit 1
