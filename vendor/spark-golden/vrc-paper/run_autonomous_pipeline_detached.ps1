# run_autonomous_pipeline_detached.ps1
# Master autonomous orchestrator for the VRC Web3DGS real experiment.
#
# Sequence:
#   Phase 0: cleanup
#   Canary 1A metrics / 1B visual (shared results root; visual gates may ADAPT: escalate CDP/splat timeouts + re-ladder)
#   Canary 2: method-isolated Full, Spark-MU, VRC (sequential ladder; same ADAPT for visual kind)
#   Canary 3: VRC multi-scenario visual
#   Prefull: Full, Spark-MU, VRC × nearby × trials=3 — strict validation + optional ADAPT on repeated ladder failure
#   Full 72-run + report: VRC_RUN_FULL_PIPELINE=1; on validation failure may re-run full matrix with escalated capture env
#
# Runner selection (two-machine):
#   If experiments\distributed_lab.json exists, phases use run_experiment_distributed.mjs (u0–u1 local + u2–u3 over SSH).
#   Override: VRC_USE_DISTRIBUTED=1 (require config) or VRC_USE_DISTRIBUTED=0 (force single-machine run_experiment.mjs).
#
# This script is intended to be Start-Process'd (detached). It writes its
# own progress to RUN_STATE.json / RUN_STATUS.md / DEBUG_LOG.md / NEXT_ACTION.md.

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
Set-Location $ScriptDir

$ResultsRoot = if ($env:VRC_RESULTS_ROOT) { $env:VRC_RESULTS_ROOT } else { Join-Path $ScriptDir "results_260512" }
$env:VRC_RESULTS_ROOT = $ResultsRoot
New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null

$LogDir = Join-Path $ResultsRoot "runner_logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$MasterTs   = Get-Date -Format "yyyyMMdd_HHmmss"
$MasterOut  = Join-Path $LogDir "orchestrator_${MasterTs}.out.log"
$MasterErr  = Join-Path $LogDir "orchestrator_${MasterTs}.err.log"
$StateFile  = Join-Path $ResultsRoot "RUN_STATE.json"
$StatusFile = Join-Path $ResultsRoot "RUN_STATUS.md"
$DebugFile  = Join-Path $ResultsRoot "DEBUG_LOG.md"
$NextFile   = Join-Path $ResultsRoot "NEXT_ACTION.md"
$ProvFile   = Join-Path $ResultsRoot "PROVENANCE.md"

# --- VRC runner: single process (4 browsers) vs distributed (2+2 over SSH) ---
$DistLabCfg = Join-Path $ScriptDir "experiments\distributed_lab.json"
$RunnerSingle = Join-Path $ScriptDir "experiments\run_experiment.mjs"
$RunnerDistributed = Join-Path $ScriptDir "experiments\run_experiment_distributed.mjs"
$UseDistributed = $false
if ($env:VRC_USE_DISTRIBUTED -eq "1") {
    $UseDistributed = $true
} elseif ($env:VRC_USE_DISTRIBUTED -eq "0") {
    $UseDistributed = $false
} elseif (Test-Path $DistLabCfg) {
    $UseDistributed = $true
}
if ($UseDistributed -and -not (Test-Path $DistLabCfg)) {
    $UseDistributed = $false
}
$VrcRunnerScript = if ($UseDistributed) { $RunnerDistributed } else { $RunnerSingle }
if ($UseDistributed -and [string]::IsNullOrWhiteSpace($env:VRC_DISTRIBUTED_CONFIG)) {
    $env:VRC_DISTRIBUTED_CONFIG = $DistLabCfg
}

# Distributed orchestrator: FAIL-FAST — no silent legacy / empty cdn_label (see run_experiment_distributed.mjs).
if ($UseDistributed) {
    $dpOk = -not [string]::IsNullOrWhiteSpace($env:VRC_DELIVERY_PROFILE)
    $clOk = -not [string]::IsNullOrWhiteSpace($env:VRC_CDN_LABEL)
    $byUserOk = -not [string]::IsNullOrWhiteSpace($env:VRC_CDN_LABEL_BY_USER)
    if ((-not $dpOk) -or ((-not $clOk) -and (-not $byUserOk))) {
        $msg = @"
FATAL: VRC_DELIVERY_PROFILE must be set, and either VRC_CDN_LABEL or VRC_CDN_LABEL_BY_USER (JSON) before launching the distributed orchestrator.
Set in this PowerShell session before Start-Process detached, e.g.:
  `$env:VRC_DELIVERY_PROFILE = 'vrc_guided_hybrid'
  `$env:VRC_CDN_LABEL        = 'cdn1'
For same-session u0-u1 hot→CDN1 / u2-u3 hot→CDN2 also set `$env:VRC_DUAL_CDN_USER_SPLIT = '1', `$env:VRC_CDN_LABEL = 'mixed', and VRC_CDN2_ASSET_BASE (cold/personal still HPC).
For origin_only runs use e.g. `$env:VRC_CDN_LABEL = 'hpc'
"@
        Write-Error $msg
        exit 1
    }
} else {
    # Single-machine defaults only (4 local browsers).
    if ([string]::IsNullOrWhiteSpace($env:VRC_DELIVERY_PROFILE)) { $env:VRC_DELIVERY_PROFILE = "vrc_guided_hybrid" }
    if ([string]::IsNullOrWhiteSpace($env:VRC_CDN_LABEL))        { $env:VRC_CDN_LABEL        = "cdn1" }
}

function WLog([string]$msg) {
    $line = "[$([DateTime]::Now.ToString('s'))] $msg"
    Write-Host $line
    Add-Content -Path $MasterOut -Value $line
}
function WDebug([string]$phase, [string]$msg) {
    Add-Content -Path $DebugFile -Value "## $([DateTime]::Now.ToString('s')) [$phase] $msg"
}
function WriteStatus([string]$phase, [string]$status, [string]$detail) {
    $body = @(
        "# RUN_STATUS",
        "",
        "- Updated: $([DateTime]::Now.ToString('s'))",
        "- Master log: $MasterOut",
        "- Phase: $phase",
        "- Status: $status",
        "- Detail: $detail"
    ) -join "`n"
    Set-Content -Path $StatusFile -Value $body
}
function UpdateState([hashtable]$patch) {
    $obj = @{}
    if (Test-Path $StateFile) {
        try { $obj = Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } catch { $obj = @{} }
    }
    foreach ($k in $patch.Keys) { $obj[$k] = $patch[$k] }
    $obj["updated"] = [DateTime]::Now.ToString("s")
    ($obj | ConvertTo-Json -Depth 8) | Set-Content -Path $StateFile
}
function WriteNext([string]$text) { Set-Content -Path $NextFile -Value $text }

function Set-DistributedOrchestratorEnv([string]$PhaseLabel) {
    if (-not $UseDistributed) { return }
    $labPath = if ($env:VRC_DISTRIBUTED_CONFIG) { $env:VRC_DISTRIBUTED_CONFIG } else { $DistLabCfg }
    if (-not (Test-Path $labPath)) {
        throw "FATAL [$PhaseLabel]: missing distributed_lab.json at $labPath"
    }
    $lab = Get-Content -Raw -Encoding UTF8 $labPath | ConvertFrom-Json
    $controller = [string]$lab.controller_host
    if (-not $controller.Trim()) {
        throw "FATAL [$PhaseLabel]: distributed_lab.json missing controller_host"
    }
    $vitePort = if ($lab.vite_port) { [string]$lab.vite_port } else { "9200" }
    $syncPort = if ($lab.sync_port) { [string]$lab.sync_port } else { "9201" }

    $env:VRC_DISTRIBUTED = "true"
    $env:VRC_WORKER_ID = "worker1"
    $env:VRC_HOST_IP = $controller.Trim()
    $env:VRC_CONTROLLER_HOST = $controller.Trim()
    $env:VRC_USER_INDICES = if ($env:VRC_USER_INDICES -and $env.VRC_USER_INDICES.Trim()) { $env:VRC_USER_INDICES.Trim() } else { "0,1" }
    $env:VITE_PORT = $vitePort
    $env:VRC_SYNC_PORT = $syncPort
    $env:VRC_SYNC_HTTP_HOST = if ($env:VRC_SYNC_HTTP_HOST -and $env:VRC_SYNC_HTTP_HOST.Trim()) { $env:VRC_SYNC_HTTP_HOST.Trim() } else { $controller.Trim() }
    WLog "[$PhaseLabel] distributed orch env: worker1 host=$($env:VRC_HOST_IP) users=$($env:VRC_USER_INDICES) vite=$vitePort sync=$syncPort"
}

function KillVrcProcs() {
    WLog "[cleanup] killing stale VRC node/chrome processes"
    try {
        Get-CimInstance Win32_Process | Where-Object {
            ($_.Name -match "node.exe|chrome.exe|chromium.exe") -and
            ($_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment|run_experiment_distributed|sync_server") -and
            ($_.CommandLine -notmatch "distributed_hard_gate|run_autonomous_pipeline_detached|dual_cdn_preflight")
        } | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
    } catch { WLog "[cleanup] non-fatal: $_" }
}

# run_experiment.mjs prints: === Experiment runner complete: N runs, M PASS, K non-PASS ===
# run_experiment_distributed.mjs prints: Done: M/N PASS → ...
function Read-NodeRunnerExitCodeFromLog([string]$outPath) {
    if (-not (Test-Path $outPath)) { return $null }
    $tail = Get-Content $outPath -Tail 160 -ErrorAction SilentlyContinue
    if (-not $tail) { return $null }
    $blob = ($tail | ForEach-Object { "$_" }) -join "`n"
    if ($blob -match '(?i)Experiment runner complete:\s*\d+\s+runs,\s*\d+\s+PASS,\s*(\d+)\s+non-PASS') {
        $np = [int]$Matches[1]
        return $(if ($np -eq 0) { 0 } else { 1 })
    }
    if ($blob -match '(?i)Done:\s*(\d+)/(\d+)\s+PASS') {
        $a = [int]$Matches[1]; $b = [int]$Matches[2]
        return $(if ($b -gt 0 -and $a -eq $b) { 0 } else { 1 })
    }
    return $null
}

function Get-LatestRunnerLog([string]$phaseName) {
    $pat = Join-Path $LogDir "${phaseName}_*.out.log"
    $hits = @(Get-ChildItem -Path $pat -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($hits.Count -gt 0) { return $hits[0].FullName }
    return $null
}

function Test-RemoteShardFailureInLog([string]$outPath) {
    if (-not $outPath -or -not (Test-Path $outPath)) { return $false }
    $tail = @(Get-Content $outPath -Tail 260 -ErrorAction SilentlyContinue)
    if (-not $tail -or $tail.Count -eq 0) { return $false }
    $blob = ($tail | ForEach-Object { "$_" }) -join "`n"
    $needles = @(
        'scp pull FAILED',
        'No such file or directory',
        'REMOTE shard failed',
        'REMOTE_SHARD_FAILED',
        'REMOTE_SHARD_LAUNCH_OR_OUTPUT_FAILURE',
        'worker dir missing',
        'cannot connect remote worker',
        'FATAL: scp pull failed',
        'FAIL_DISTRIBUTED_SCP',
        'FAIL_DISTRIBUTED_REMOTE'
    )
    foreach ($n in $needles) {
        if ($blob -match [regex]::Escape($n)) { return $true }
    }
    if ($blob -match 'connect:\s*u[01]' -and $blob -notmatch 'connect:\s*u2') {
        if ($blob -match 'remote shard|ssh\s+\S+@10\.') { return $true }
    }
    return $false
}

function Test-CanaryHardGate([string]$resultsRoot, [string]$phaseName) {
    $pf = Join-Path $resultsRoot "summary\run_pass_fail.csv"
    if (-not (Test-Path $pf)) {
        WLog "[$phaseName] hard-gate FAIL: missing run_pass_fail.csv"
        return $false
    }
    $rows = @(Import-Csv $pf -ErrorAction SilentlyContinue)
    if ($rows.Count -lt 1) {
        WLog "[$phaseName] hard-gate FAIL: run_pass_fail.csv empty"
        return $false
    }
    $r = $rows[-1]
    if ($r.status -ne "PASS") {
        WLog "[$phaseName] hard-gate FAIL: status=$($r.status) fail_reason=$($r.fail_reason)"
        return $false
    }
  $pcm = Join-Path $resultsRoot "summary\per_client_metrics.csv"
    if (-not (Test-Path $pcm)) {
        WLog "[$phaseName] hard-gate FAIL: missing per_client_metrics.csv"
        return $false
    }
    $pm = @(Import-Csv $pcm -ErrorAction SilentlyContinue)
    $sid = [string]$r.session_id
    $users = @($pm | Where-Object { $_.session_id -eq $sid })
    if ($users.Count -lt 4) {
        WLog "[$phaseName] hard-gate FAIL: per_client_metrics users=$($users.Count) (need 4 for session $sid)"
        return $false
    }
    foreach ($u in $users) {
        $fps = 0.0
        try { $fps = [double]$u.fps } catch { $fps = 0 }
        if ($fps -le 0) {
            WLog "[$phaseName] hard-gate FAIL: $($u.user_id) fps=$fps"
            return $false
        }
        if ([string]$u.metrics_source -match 'no_chunk_timing') {
            WLog "[$phaseName] hard-gate FAIL: $($u.user_id) metrics_source=no_chunk_timing"
            return $false
        }
        $bytes = 0
        try { $bytes = [double]$u.aggregate_client_bytes } catch { $bytes = 0 }
        if ($bytes -le 0) {
            WLog "[$phaseName] hard-gate FAIL: $($u.user_id) aggregate_client_bytes=$bytes"
            return $false
        }
    }
    $logPath = Get-LatestRunnerLog $phaseName
    if ($logPath -and (Test-RemoteShardFailureInLog $logPath)) {
        WLog "[$phaseName] hard-gate FAIL: remote shard failure markers in runner log"
        return $false
    }
    if ($logPath) {
        $logBlob = (Get-Content $logPath -Tail 400 -ErrorAction SilentlyContinue) -join "`n"
        foreach ($uid in @('u0','u1','u2','u3')) {
            if ($logBlob -notmatch "connect:\s*$uid") {
                WLog "[$phaseName] hard-gate FAIL: sync log missing connect: $uid"
                return $false
            }
        }
    }
    return $true
}

# Clears orchestrator-owned adaptive knobs so the next gate starts from runner defaults.
function Clear-VisualAdaptiveTimeouts {
    foreach ($k in @(
        "VRC_SCREENSHOT_DELAY_MS","VRC_CDP_CAPTURE_TIMEOUT_MS","VRC_VIEWPORT_CAPTURE_TIMEOUT_MS",
        "VRC_DATAURL_CAPTURE_TIMEOUT_MS","VRC_PER_USER_CAPTURE_MS","VRC_SEQ_FPS_WAIT_MS",
        "VRC_LOW_FPS_PROBE_MS","VRC_GOTO_TIMEOUT_MS"
    )) { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
}

# Escalates per-user capture / CDP / splat-wait budgets (round 1..N). Caller clears between canaries.
function Set-VisualAdaptiveRound([int]$round) {
    if ($round -le 0) { return }
    $env:VRC_SCREENSHOT_DELAY_MS = [string](10000 + [Math]::Min(80000, 15000 * $round))
    $cdp = [Math]::Min(35000, 5000 + 10000 * $round)
    $env:VRC_CDP_CAPTURE_TIMEOUT_MS = "$cdp"
    $env:VRC_VIEWPORT_CAPTURE_TIMEOUT_MS = "$cdp"
    $env:VRC_DATAURL_CAPTURE_TIMEOUT_MS = [string]([Math]::Min(35000, 8000 + 8000 * $round))
    $env:VRC_PER_USER_CAPTURE_MS = [string]([Math]::Min(300000, 45000 + 55000 * $round))
    $env:VRC_SEQ_FPS_WAIT_MS = [string]([Math]::Min(90000, 15000 + 15000 * $round))
    $env:VRC_LOW_FPS_PROBE_MS = [string]([Math]::Min(180000, 30000 + 25000 * $round))
    $env:VRC_GOTO_TIMEOUT_MS = [string]([Math]::Min(120000, 30000 + 15000 * $round))
}

function Get-AdaptMaxRounds {
    $m = 6
    if (-not [string]::IsNullOrWhiteSpace($env:VRC_ADAPT_MAX_ROUNDS)) {
        try { $m = [int]$env:VRC_ADAPT_MAX_ROUNDS } catch { $m = 6 }
    }
    if ($m -lt 0) { $m = 0 }
    return $m
}

function Get-AdaptMaxFullRounds {
    $m = 4
    if (-not [string]::IsNullOrWhiteSpace($env:VRC_ADAPT_MAX_FULL_ROUNDS)) {
        try { $m = [int]$env:VRC_ADAPT_MAX_FULL_ROUNDS } catch { $m = 4 }
    }
    if ($m -lt 0) { $m = 0 }
    return $m
}

function RunPhase([string]$phaseName, [string]$methods, [string]$scenarios, [int]$trials, [int]$timeoutMin, [string]$ResultRootOverride = $null) {
    $rr = if ($ResultRootOverride) { $ResultRootOverride } else { $ResultsRoot }
    WLog "[$phaseName] launching methods=$methods scenarios=$scenarios trials=$trials VRC_RESULTS_ROOT=$rr"
    UpdateState @{ phase = $phaseName }
    WriteStatus $phaseName "RUNNING" "methods=$methods scenarios=$scenarios trials=$trials"

    New-Item -ItemType Directory -Force -Path $rr | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $rr "raw") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $rr "summary") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $rr "screenshots") | Out-Null

    $env:VRC_METHODS    = $methods
    $env:VRC_SCENARIOS  = $scenarios
    $env:VRC_TRIALS     = "$trials"
    $env:VRC_TRIAL_DURATION_MS = "30000"
    # Preserve orchestrator-set VRC_HEADLESS (strategy C uses "false"). Default headless if unset.
    if ([string]::IsNullOrWhiteSpace($env:VRC_HEADLESS)) { $env:VRC_HEADLESS = "true" }
    $env:VRC_SMOKE      = "0"
    $env:VITE_PORT      = "9200"
    $env:VRC_SYNC_PORT  = "9201"
    $env:VRC_PHASE      = $phaseName
    $env:VRC_RESULTS_ROOT = $rr
    if ($phaseName -match '^canary') {
        Remove-Item Env:VRC_CONTINUE_ON_FAIL -ErrorAction SilentlyContinue
        Remove-Item Env:VRC_NO_HALT_ON_CANARY -ErrorAction SilentlyContinue
    }
    if ($UseDistributed) {
        Set-DistributedOrchestratorEnv $phaseName
    } else {
        Remove-Item Env:VRC_DISTRIBUTED -ErrorAction SilentlyContinue
    }

    # Prefer flat R2 object keys when unset (avoids a stale shell VRC_RAD_KEY_COIT or old defaults).
    if ($env:VRC_USE_GCS_ONLY -ne "1" -and [string]::IsNullOrWhiteSpace($env:VRC_RAD_KEY_COIT)) {
        $env:VRC_RAD_KEY_COIT = "streaming-lod/coit-40m-sh1-lod.rad"
    }

    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
    if (-not (Test-Path $node)) { WLog "[$phaseName] FATAL: node.exe missing"; return $false }

    $runnerScript = $VrcRunnerScript
    $argList = @("`"$runnerScript`"")
    if (-not $UseDistributed) { $argList += "--full" }

    $phaseTs   = Get-Date -Format "yyyyMMdd_HHmmss"
    $pOut = Join-Path $LogDir "${phaseName}_${phaseTs}.out.log"
    $pErr = Join-Path $LogDir "${phaseName}_${phaseTs}.err.log"

    $proc = Start-Process -FilePath $node -ArgumentList $argList `
        -WorkingDirectory $RepoRoot `
        -RedirectStandardOutput $pOut `
        -RedirectStandardError  $pErr `
        -WindowStyle Hidden -PassThru
    $childPid = $proc.Id
    WLog "[$phaseName] child pid=$childPid out=$pOut"
    UpdateState @{ child_pid = $childPid; child_log = $pOut }

    # Use the System.Diagnostics.Process directly so WaitForExit flushes ExitCode.
    # $proc.ExitCode from Start-Process -PassThru is sometimes null after polling
    # HasExited; the .NET object obtained via Get-Process + WaitForExit is reliable.
    $deadline = (Get-Date).AddMinutes($timeoutMin)
    $timedOut = $false
    while ($true) {
        $running = Get-Process -Id $childPid -ErrorAction SilentlyContinue
        if (-not $running) { break }
        if ((Get-Date) -gt $deadline) {
            $timedOut = $true
            WLog "[$phaseName] TIMEOUT after $timeoutMin min, killing pid $childPid"
            try { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue } catch {}
            KillVrcProcs
            WDebug $phaseName "timeout after $timeoutMin min"
            break
        }
        Start-Sleep -Seconds 10
    }
    if ($timedOut) { return $false }

    # Redirected stdout can lag slightly behind process exit; ExitCode is only reliable after WaitForExit.
    Start-Sleep -Milliseconds 400
    try {
        [void]$proc.WaitForExit(180000)
    } catch {
        WLog "[$phaseName] WaitForExit: $($_.Exception.Message)"
    }
    try { $proc.Refresh() } catch {}

    $code = $null
    try { $code = $proc.ExitCode } catch { $code = $null }

    if ($null -eq $code) {
        Start-Sleep -Milliseconds 300
        try { $proc.Refresh(); $code = $proc.ExitCode } catch { $code = $null }
    }

    if ($null -eq $code) {
        $fromLog = Read-NodeRunnerExitCodeFromLog $pOut
        if ($null -ne $fromLog) {
            $code = $fromLog
            WLog "[$phaseName] ExitCode was unavailable from Process object; inferred from stdout: $code"
        }
    }

    if ($null -eq $code) {
        WLog "[$phaseName] FATAL: cannot read child ExitCode and no runner summary line in $pOut (expected 'Experiment runner complete' or distributed 'Done:')"
        WDebug $phaseName "missing ExitCode and log tail — see $pOut / $pErr"
        return $false
    }

    WLog "[$phaseName] child exit code=$code"
    if ($code -ne 0) { WDebug $phaseName "child exit code=$code (see $pErr)"; return $false }
    if (Test-RemoteShardFailureInLog $pOut) {
        WLog "[$phaseName] classified REMOTE_SHARD_LAUNCH_OR_OUTPUT_FAILURE (runner log)"
        return $false
    }
    if ($phaseName -match '^canary') {
        if (-not (Test-CanaryHardGate $rr $phaseName)) { return $false }
    }
    return $true
}

function ValidateMatrix([string]$methods, [string]$scenarios, [int]$trials) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "validate_real_experiment.ps1") `
        -Methods $methods -Scenarios $scenarios -Trials $trials *>> $MasterOut
    return ($LASTEXITCODE -eq 0)
}

# ── ENTRY ────────────────────────────────────────────────────────────────────
WLog "=== MASTER ORCHESTRATOR START pid=$PID ==="
WLog "VRC runner: $VrcRunnerScript (distributed=$UseDistributed; hint: set VRC_USE_DISTRIBUTED=0 to force single-machine when distributed_lab.json exists)"
# Default pipeline: Cloudflare R2 pub + flat streaming-lod/*.rad (see vrc_scene.html + run_experiment resolveRadCdn).
# Force Google .rad only for the whole orchestrator child:
#   $env:VRC_USE_GCS_ONLY = "1"
if ($env:VRC_USE_GCS_ONLY -eq "1") {
    WLog "[rad-cdn] VRC_USE_GCS_ONLY=1 — .rad from Google storage only"
} elseif ($env:VRC_RAD_ASSET_BASE) {
    WLog "[rad-cdn] VRC_RAD_ASSET_BASE=$($env:VRC_RAD_ASSET_BASE) (optional VRC_RAD_KEY_COIT / VRC_RAD_KEY_HOBBITON)"
} else {
    WLog "[rad-cdn] default Cloudflare R2 pub + flat streaming-lod/*.rad probe; set VRC_USE_GCS_ONLY=1 to skip CDN"
}
if ($env:VRC_USE_GCS_ONLY -ne "1" -and $env:VRC_RAD_KEY_COIT -match "asundqui/rad") {
    WLog "[rad-cdn] WARNING: VRC_RAD_KEY_COIT is legacy nested path — ensure that object exists on R2 or clear it to use flat streaming-lod/coit-40m-sh1-lod.rad"
}
WriteNext "Master orchestrator running (pid=$PID). Logs: $MasterOut"
UpdateState @{ master_pid = $PID; master_log = $MasterOut; master_err = $MasterErr; phase = "phase0_audit" }
Add-Content -Path $DebugFile -Value "`n# Orchestrator run $MasterTs (pid=$PID)`n"

if ($env:VRC_ADAPTIVE_VISUAL -eq "0") {
    WLog "[ADAPT] VRC_ADAPTIVE_VISUAL=0 — visual gates use strategy ladder only (no timeout escalation between rounds)"
} else {
    WLog "[ADAPT] VRC_ADAPTIVE_VISUAL on (default): visual canaries / prefull / full re-run with longer CDP+splat waits until pass or VRC_ADAPT_MAX_ROUNDS / VRC_ADAPT_MAX_FULL_ROUNDS"
}

# Hard gate first (before cleanup kills in-flight node children)
if ($UseDistributed -and $env:VRC_SKIP_HARD_GATE -ne "1") {
    WLog "=== distributed hard gate (pre-canary, before cleanup) ==="
    Set-DistributedOrchestratorEnv "hard_gate"
    $hgOut = Join-Path $LogDir "hard_gate_pre.out.log"
    $hgErr = Join-Path $LogDir "hard_gate_pre.err.log"
    $hgProc = Start-Process -FilePath "node" `
        -ArgumentList @((Join-Path $ScriptDir "experiments\distributed_hard_gate.mjs"), "--pre-run") `
        -WorkingDirectory $ScriptDir `
        -RedirectStandardOutput $hgOut `
        -RedirectStandardError $hgErr `
        -WindowStyle Hidden -PassThru -Wait
    $hgCode = $null
    try { $hgProc.Refresh(); $hgCode = $hgProc.ExitCode } catch { $hgCode = 1 }
    if ($null -eq $hgCode) { $hgCode = 1 }
    if (Test-Path $hgOut) { Get-Content $hgOut -ErrorAction SilentlyContinue | ForEach-Object { WLog $_ } }
    if (($hgCode -ne 0) -and (Test-Path $hgErr)) {
        Get-Content $hgErr -ErrorAction SilentlyContinue | ForEach-Object { WLog "[hard-gate-err] $_" }
    }
    if ($hgCode -ne 0) {
        WriteStatus "hard_gate" "FAIL" "distributed_hard_gate --pre-run exit=$hgCode"
        UpdateState @{ phase = "hard_gate_failed"; halted = $true }
        WriteNext "Hard gate failed. Fix Worker2 SSH/scp/remote_repo_path, run: node experiments/distributed_hard_gate.mjs --pre-run"
        exit 1
    }
    $env:VRC_DISTRIBUTED_PUSH_TO_WORKER2 = "0"
    $env:VRC_DISTRIBUTED_PUSH_VRC_PAPER = "0"
} elseif ($UseDistributed) {
    WLog "[skip] VRC_SKIP_HARD_GATE=1 — pre-canary Worker2 gate skipped"
}

# Phase 0: cleanup
KillVrcProcs
Start-Sleep -Seconds 2
KillVrcProcs
WriteStatus "phase0_audit" "OK" "stale processes killed"

# Canary 1 is split into two gates (1A metrics, 1B visual).
# Canary 2 is split into THREE method-isolated gates (Full, Spark-MU, VRC), each with
# its own VRC_RESULTS_ROOT subtree, cleanup between methods, and no parallel capture
# (sequential/headful ladder only) to avoid GPU starvation across methods.
# Canary 3: VRC multi-scenario visual gate.
# Prefull: Full / Spark-MU / VRC on nearby with trials=3 — each method must PASS
# 3 times in a row under VRC_VALIDATE_STRICT before the full 72-run is allowed.
# Set VRC_RUN_FULL_PIPELINE=1 to run the full matrix + aggregation after prefull.

$visualStrategies = @(
    @{ Name = "A_parallel_headless";   Headless = "true";  CaptureMode = "parallel";   TimeoutMin = 10 },
    @{ Name = "B_sequential_headless"; Headless = "true";  CaptureMode = "sequential"; TimeoutMin = 28 },
    @{ Name = "C_sequential_headful";  Headless = "false"; CaptureMode = "sequential"; TimeoutMin = 36 }
)

$visualStrategiesNoParallel = @(
    @{ Name = "B_sequential_headless"; Headless = "true";  CaptureMode = "sequential"; TimeoutMin = 32 },
    @{ Name = "C_sequential_headful";  Headless = "false"; CaptureMode = "sequential"; TimeoutMin = 42 }
)

$metricsStrategies = @(
    @{ Name = "M_metrics_only_headless"; Headless = "true"; CaptureMode = "metrics_only"; TimeoutMin = 10 }
)

$canaries = @(
    @{ Name = "canary1a_metrics"; Methods = "Full";      Scenarios = "nearby";                       Trials = 1; Kind = "metrics"; IsolatedDir = $null; SkipParallel = $false },
    @{ Name = "canary1b_visual";  Methods = "Full";      Scenarios = "nearby";                       Trials = 1; Kind = "visual";  IsolatedDir = $null; SkipParallel = $false },
    @{ Name = "canary2_full";     Methods = "Full";      Scenarios = "nearby";                       Trials = 1; Kind = "visual";  IsolatedDir = "isolated_canary2_Full";     SkipParallel = $true },
    @{ Name = "canary2_spark_mu"; Methods = "Spark-MU";  Scenarios = "nearby";                       Trials = 1; Kind = "visual";  IsolatedDir = "isolated_canary2_Spark-MU"; SkipParallel = $true },
    @{ Name = "canary2_vrc";      Methods = "VRC";       Scenarios = "nearby";                       Trials = 1; Kind = "visual";  IsolatedDir = "isolated_canary2_VRC";      SkipParallel = $true },
    @{ Name = "canary3";          Methods = "VRC";       Scenarios = "nearby,burst_turn,divergent"; Trials = 1; Kind = "visual";  IsolatedDir = $null; SkipParallel = $false }
)

$runFullPipeline = ($env:VRC_RUN_FULL_PIPELINE -eq "1")
$noHaltOnCanary = ($env:VRC_NO_HALT_ON_CANARY -eq "1")
$skipPrefullGate = ($env:VRC_SKIP_PREFULL_GATE -eq "1")
$noHaltOnFull = ($env:VRC_NO_HALT_ON_FULL -eq "1")
$canaryOnly = ($env:VRC_CANARY_ONLY -eq "1")
$canaryFilter = @()
if ($env:VRC_CANARY_NAMES -and $env:VRC_CANARY_NAMES.Trim()) {
    $canaryFilter = $env:VRC_CANARY_NAMES.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

$allCanariesPass = $true
foreach ($c in $canaries) {
    if ($canaryOnly -and $canaryFilter.Count -gt 0 -and ($canaryFilter -notcontains $c.Name)) {
        WLog "[skip] VRC_CANARY_ONLY filter — omit $($c.Name)"
        continue
    }
    if ($canaryOnly -and $canaryFilter.Count -eq 0 -and $c.Name -notin @("canary1a_metrics", "canary2_full")) {
        WLog "[skip] VRC_CANARY_ONLY=1 default — omit $($c.Name)"
        continue
    }
    if ($c.Name -eq "canary1b_visual" -and $env:VRC_SKIP_CANARY1B_VISUAL -eq "1") {
        WLog "[skip] VRC_SKIP_CANARY1B_VISUAL=1 — canary1b visual gate skipped; metrics canaries + prefull/full continue"
        WDebug $c.Name "skipped by VRC_SKIP_CANARY1B_VISUAL"
        UpdateState @{ phase = "canary1b_visual_skipped"; completed_canary_1b = $true }
        continue
    }
    Clear-VisualAdaptiveTimeouts
    $passed = $false
    $ladder = if ($c.Kind -eq "metrics") { $metricsStrategies }
        elseif ($c.SkipParallel) { $visualStrategiesNoParallel }
        else { $visualStrategies }

    $adaptiveVisual = ($c.Kind -eq "visual") -and ($env:VRC_ADAPTIVE_VISUAL -ne "0")
    $maxAdaptRounds = Get-AdaptMaxRounds

    $adaptR = 0
    $remoteShardFailure = $false
    while (-not $passed) {
        if ($adaptiveVisual -and $adaptR -gt 0) {
            Set-VisualAdaptiveRound $adaptR
            WLog "[ADAPT $($c.Name)] round $adaptR / $maxAdaptRounds — VRC_SCREENSHOT_DELAY_MS=$($env:VRC_SCREENSHOT_DELAY_MS) VRC_CDP_CAPTURE_TIMEOUT_MS=$($env:VRC_CDP_CAPTURE_TIMEOUT_MS) VRC_PER_USER_CAPTURE_MS=$($env:VRC_PER_USER_CAPTURE_MS) VRC_SEQ_FPS_WAIT_MS=$($env:VRC_SEQ_FPS_WAIT_MS)"
            WDebug $c.Name "ADAPT round $adaptR max=$maxAdaptRounds"
        } elseif ($adaptiveVisual -and $adaptR -eq 0) {
            WLog "[ADAPT $($c.Name)] round 0 — runner defaults (set VRC_ADAPTIVE_VISUAL=0 to skip adaptive re-ladder)"
        }

        foreach ($s in $ladder) {
            if ($passed) { break }
            WLog "[$($c.Name)] strategy=$($s.Name) headless=$($s.Headless) capture_mode=$($s.CaptureMode) timeout_min=$($s.TimeoutMin) adaptR=$adaptR"
            UpdateState @{ phase = "$($c.Name)_strategy_$($s.Name)_r$adaptR" }
            KillVrcProcs
            Start-Sleep -Seconds 3
            KillVrcProcs
            Start-Sleep -Seconds 2
            $env:VRC_HEADLESS     = $s.Headless
            $env:VRC_CAPTURE_MODE = $s.CaptureMode
            $isoPath = $null
            if ($c.IsolatedDir) {
                $isoPath = Join-Path $ResultsRoot ($c.IsolatedDir + "_" + (Get-Date -Format "yyyyMMddHHmmss"))
            }
            if ($isoPath) { $env:VRC_VALIDATE_STRICT = "1" } else { Remove-Item env:VRC_VALIDATE_STRICT -ErrorAction SilentlyContinue }
            $timeoutExtra = 0
            if ($adaptiveVisual) { $timeoutExtra = [Math]::Min(45, 5 * $adaptR) }
            $effTimeout = $s.TimeoutMin + $timeoutExtra
            $ok = RunPhase $c.Name $c.Methods $c.Scenarios $c.Trials $effTimeout $isoPath
            $vok = $false
            if ($ok) { $vok = ValidateMatrix $c.Methods $c.Scenarios $c.Trials }
            Remove-Item env:VRC_VALIDATE_STRICT -ErrorAction SilentlyContinue
            if ($ok -and $vok) {
                WLog "[$($c.Name)] PASS strategy=$($s.Name) adaptR=$adaptR"
                WDebug $c.Name "PASS strategy=$($s.Name) adaptR=$adaptR"
                UpdateState @{ "$($c.Name)_passed_strategy" = $s.Name; "$($c.Name)_adapt_round" = "$adaptR" }
                $passed = $true
            } else {
                if (-not $ok) {
                    WLog "[$($c.Name)] runner failed strategy=$($s.Name) adaptR=$adaptR"
                    WDebug $c.Name "runner failed/timeout strategy=$($s.Name) adaptR=$adaptR — see runner_logs"
                    $latestLog = Get-LatestRunnerLog $c.Name
                    if ($latestLog -and (Test-RemoteShardFailureInLog $latestLog)) {
                        $remoteShardFailure = $true
                        WLog "[$($c.Name)] REMOTE_SHARD_LAUNCH_OR_OUTPUT_FAILURE — skip visual adaptive ladder"
                    }
                } else {
                    WLog "[$($c.Name)] validation FAIL strategy=$($s.Name) adaptR=$adaptR"
                    WDebug $c.Name "validation FAIL strategy=$($s.Name) adaptR=$adaptR — see VALIDATION_REPORT.md"
                }
            }
            if (-not $passed) { Start-Sleep -Seconds 10 }
        }

        if ($passed) { break }
        if ($remoteShardFailure) { break }
        if (-not $adaptiveVisual) { break }
        if ($adaptR -ge $maxAdaptRounds) { break }
        $adaptR++
        WLog "[ADAPT $($c.Name)] ladder exhausted; next escalation round=$adaptR (max $maxAdaptRounds) — longer splat/CDP/per-user capture"
        Start-Sleep -Seconds 5
    }

    if (-not $passed) {
        $allCanariesPass = $false
        WriteStatus $c.Name "FAIL" "exhausted retries (adaptive rounds=$maxAdaptRounds if visual)"
        WLog "=== canary $($c.Name) failed permanently ==="
        if ($noHaltOnCanary) {
            WLog "[no-halt] VRC_NO_HALT_ON_CANARY=1 — continuing to prefull/full pipeline"
            WDebug $c.Name "failed but no-halt; see runner_logs"
            UpdateState @{ phase = "$($c.Name)_failed_continue"; halted = $false }
        } else {
            WriteNext "Canary $($c.Name) failed after retries. Inspect $MasterOut and runner_logs\$($c.Name)_*.err.log. Set VRC_ADAPT_MAX_ROUNDS higher or VRC_ADAPTIVE_VISUAL=0. Re-launch after fix."
            UpdateState @{ phase = "$($c.Name)_failed"; halted = $true }
            WLog "=== HALT: canary $($c.Name) failed permanently ==="
            exit 1
        }
    }
    UpdateState @{ phase = "$($c.Name)_passed" } | Out-Null
    if ($c.Name -eq "canary1a_metrics") { UpdateState @{ completed_canary_1a = $true } }
    if ($c.Name -eq "canary1b_visual") { UpdateState @{ completed_canary_1b = $true } }
    if ($c.Name -eq "canary2_vrc") { UpdateState @{ completed_canary_2 = $true } }
    if ($c.Name -eq "canary3") { UpdateState @{ completed_canary_3 = $true } }
}

if (-not $allCanariesPass) {
    if ($noHaltOnCanary) {
        WLog "=== WARN: not all canaries passed — VRC_NO_HALT_ON_CANARY=1, continuing ==="
    } else {
        WLog "=== HALT: not all canaries passed ==="
        exit 1
    }
}

# --- Prefull gate: each method × nearby × trials=3 must PASS 3 consecutive times (strict) ---
if ($skipPrefullGate) {
    WLog "[skip] VRC_SKIP_PREFULL_GATE=1 — prefull 3× streak gate skipped; proceeding to full 72 when VRC_RUN_FULL_PIPELINE=1"
} else {
$env:VRC_VALIDATE_STRICT = "1"
$adaptivePrefull = ($env:VRC_ADAPTIVE_VISUAL -ne "0")
$maxPrefullAdapt = Get-AdaptMaxRounds
$prefullMethods = @("Full","Spark-MU","VRC")
foreach ($pm in $prefullMethods) {
    $streak = 0
    $guard = 0
    $prefullAdaptR = 0
    while ($streak -lt 3) {
        if ($guard++ -ge 80) {
            WLog "FATAL: prefull_$pm exceeded 80 attempts without 3-pass streak"
            WriteStatus "prefull_failed" "FAIL" "method=$pm guard exhausted"
            UpdateState @{ phase = "prefull_failed"; halted = $true }
            exit 1
        }
        WLog "[prefull_$pm] consecutive strict PASS streak=$streak/3 guard=$guard adaptR=$prefullAdaptR"
        if ($adaptivePrefull -and $prefullAdaptR -gt 0) {
            Set-VisualAdaptiveRound $prefullAdaptR
            WLog "[ADAPT prefull_$pm] round $prefullAdaptR — VRC_PER_USER_CAPTURE_MS=$($env:VRC_PER_USER_CAPTURE_MS) VRC_SCREENSHOT_DELAY_MS=$($env:VRC_SCREENSHOT_DELAY_MS)"
        }
        $pOk = $false
        foreach ($s in $visualStrategiesNoParallel) {
            if ($pOk) { break }
            $isoPath = Join-Path $ResultsRoot ("prefull_" + ($pm -replace "[^A-Za-z0-9]","_") + "_st" + $streak + "_" + $s.Name + "_" + (Get-Date -Format "yyyyMMddHHmmss"))
            WLog "[prefull_$pm] strategy=$($s.Name) isolated=$isoPath"
            UpdateState @{ phase = "prefull_${pm}_$($s.Name)" }
            KillVrcProcs
            Start-Sleep -Seconds 3
            KillVrcProcs
            Start-Sleep -Seconds 2
            $env:VRC_HEADLESS     = $s.Headless
            $env:VRC_CAPTURE_MODE = $s.CaptureMode
            $timeoutMin = [Math]::Min(120, $s.TimeoutMin + 75 + [Math]::Min(60, 10 * $prefullAdaptR))
            $runOk = RunPhase "prefull_$pm" $pm "nearby" 3 $timeoutMin $isoPath
            $valOk = $false
            if ($runOk) { $valOk = ValidateMatrix $pm "nearby" 3 }
            if ($runOk -and $valOk) {
                WLog "[prefull_$pm] PASS strategy=$($s.Name) (streak now $($streak + 1))"
                $pOk = $true
            } else {
                WLog "[prefull_$pm] FAIL strategy=$($s.Name) — resetting streak"
            }
        }
        if ($pOk) {
            $streak++
            $prefullAdaptR = 0
            Clear-VisualAdaptiveTimeouts
        } else {
            $streak = 0
            if ($adaptivePrefull -and $prefullAdaptR -lt $maxPrefullAdapt) {
                $prefullAdaptR++
                WLog "[ADAPT prefull_$pm] ladder failed; escalating to adaptR=$prefullAdaptR (max $maxPrefullAdapt)"
            }
        }
    }
}
Remove-Item env:VRC_VALIDATE_STRICT -ErrorAction SilentlyContinue
$env:VRC_RESULTS_ROOT = $ResultsRoot
WLog "=== Prefull gate complete (3× consecutive PASS per method: Full, Spark-MU, VRC) ==="
}

if ($canaryOnly) {
    if (-not $allCanariesPass) {
        WriteStatus "canary_only" "FAIL" "one or more canaries failed — fix before 10-run or 72-run"
        UpdateState @{ phase = "canary_only_failed"; halted = $true }
        exit 1
    }
    WriteStatus "canary_only" "PASS" "VRC_CANARY_ONLY gate passed"
    WriteNext "Canary gate PASS. Next: 10-run prefull (`$env:VRC_PREFULL_10_RUN='1') or set VRC_RUN_FULL_PIPELINE=1 for full matrix."
    UpdateState @{ phase = "canary_only_pass"; halted = $false; finished_at = [DateTime]::Now.ToString("s") }
    WLog "=== MASTER ORCHESTRATOR DONE (canary-only) pid=$PID ==="
    exit 0
}

if (-not $runFullPipeline) {
    WriteStatus "prefull_complete" "PASS" "canaries + prefull OK; full 72-run skipped (set VRC_RUN_FULL_PIPELINE=1)"
    WriteNext "Prefull complete. To run full 72 matrix + aggregation: `$env:VRC_RUN_FULL_PIPELINE='1' then re-launch this orchestrator."
    UpdateState @{ phase = "prefull_complete"; halted = $false; finished_at = [DateTime]::Now.ToString("s") }
    WLog "=== MASTER ORCHESTRATOR DONE (prefull-only) pid=$PID ==="
    exit 0
}

# Full 72-run experiment (only when VRC_RUN_FULL_PIPELINE=1)
WLog "=== Prefull OK — launching full 72-run experiment ==="
UpdateState @{ phase = "full_experiment" }
WriteStatus "full_experiment" "RUNNING" "8 methods x 3 scenarios x 3 trials = 72"

$fullMethods   = "Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC"
$fullScenarios = "nearby,burst_turn,divergent"
$fullTrials    = 3

$adaptiveFull = ($env:VRC_ADAPTIVE_VISUAL -ne "0")
$maxFullRounds = Get-AdaptMaxFullRounds
$fullAdaptR = 0
while ($true) {
    KillVrcProcs
    Start-Sleep -Seconds 3
    Remove-Item env:VRC_VALIDATE_STRICT -ErrorAction SilentlyContinue
    $env:VRC_HEADLESS = "true"
    $env:VRC_CAPTURE_MODE = "parallel"
    if ($fullAdaptR -eq 0) { Clear-VisualAdaptiveTimeouts }
    if ($adaptiveFull -and $fullAdaptR -gt 0) {
        Set-VisualAdaptiveRound $fullAdaptR
        WLog "[ADAPT full] matrix re-run round $fullAdaptR / $maxFullRounds — VRC_PER_USER_CAPTURE_MS=$($env:VRC_PER_USER_CAPTURE_MS) VRC_SCREENSHOT_DELAY_MS=$($env:VRC_SCREENSHOT_DELAY_MS)"
        WDebug "full" "ADAPT full matrix round $fullAdaptR"
    }

    $fullWallMin = [Math]::Min(600, 360 + 90 * $fullAdaptR)
    $ok = RunPhase "full" $fullMethods $fullScenarios $fullTrials $fullWallMin $null

    # Resume any missing / failed runs (up to 12 resume passes when continue-on-fail)
    $maxResume = if ($noHaltOnFull) { 12 } else { 3 }
    for ($r = 1; $r -le $maxResume; $r++) {
        $vok = ValidateMatrix $fullMethods $fullScenarios $fullTrials
        if ($vok) { WLog "[full] validation PASS at resume_pass=$r (adaptR=$fullAdaptR)"; break }
        WLog "[full] validation FAIL at resume_pass=$r — running resume"
        UpdateState @{ phase = "full_resume_$r" }
        KillVrcProcs
        & powershell -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "resume_real_experiment.ps1") `
            -Methods $fullMethods -Scenarios $fullScenarios -Trials $fullTrials *>> $MasterOut
        Start-Sleep -Seconds 30
        $resPid = $null
        if (Test-Path (Join-Path $ScriptDir "RUNNER_PID.txt")) {
            try { $resPid = [int]((Get-Content (Join-Path $ScriptDir "RUNNER_PID.txt") -First 1)) } catch {}
        }
        if ($resPid) {
            $deadline = (Get-Date).AddMinutes(240)
            while ((Get-Process -Id $resPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
                Start-Sleep -Seconds 30
            }
        }
    }

    $finalOk = ValidateMatrix $fullMethods $fullScenarios $fullTrials
    if ($finalOk) {
        if ($fullAdaptR -gt 0) { WLog "[ADAPT full] validation PASS after adaptive round $fullAdaptR" }
        break
    }
    if (-not $adaptiveFull -or $fullAdaptR -ge $maxFullRounds) {
        if ($noHaltOnFull) {
            WLog "=== WARN: full validation still failing after adaptR=$fullAdaptR — VRC_NO_HALT_ON_FULL=1, continuing to report ==="
            break
        }
        WriteStatus "full_experiment" "FAIL" "validation failed after resumes — see VALIDATION_REPORT.md"
        WriteNext "Full 72-run experiment validation FAILED. Inspect VALIDATION_REPORT.md. Set VRC_ADAPT_MAX_FULL_ROUNDS or enable adaptive (default VRC_ADAPTIVE_VISUAL on)."
        UpdateState @{ phase = "full_failed"; halted = $true }
        WLog "=== HALT: full experiment validation failed (adaptR=$fullAdaptR max=$maxFullRounds) ==="
        exit 1
    }
    $fullAdaptR++
    WLog "[ADAPT full] validation still failing — escalating capture env and re-running entire 72 matrix from scratch"
    Start-Sleep -Seconds 15
}

# Phase 6: aggregation + figures + report
WLog "=== Validation PASS — generating CSVs / figures / report ==="
UpdateState @{ phase = "aggregate_and_report" }
WriteStatus "aggregate_and_report" "RUNNING" "running analyze.py / plot_figures.py / generate_report.py"

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }

$analysisDir = Join-Path $ScriptDir "analysis"
foreach ($script in @("aggregate_metrics.py","plot_figures.py","generate_report.py")) {
    $f = Join-Path $analysisDir $script
    if ((Test-Path $f) -and $python) {
        WLog "[report] running $script"
        & $python $f *>> $MasterOut
        if ($LASTEXITCODE -ne 0) { WDebug "report" "$script exit=$LASTEXITCODE" }
    } else {
        WLog "[report] skip $script (missing script or python)"
    }
}

# Provenance + final NEXT_ACTION
$prov = @(
    "# PROVENANCE",
    "",
    "- Orchestrator pid: $PID",
    "- Started: $MasterTs",
    "- Finished: $([DateTime]::Now.ToString('s'))",
    "- Master log: $MasterOut",
    "- Runner: $VrcRunnerScript",
    "- Distributed (2+2): $UseDistributed",
    "- Methods: $fullMethods",
    "- Scenarios: $fullScenarios",
    "- Trials: $fullTrials",
    "- Result root: vrc-paper\results\",
    "- Validation: VALIDATION_REPORT.md"
) -join "`n"
Set-Content -Path $ProvFile -Value $prov

WriteStatus "complete" "PASS" "all canaries + full 72 + validation + report"
UpdateState @{ phase = "complete"; halted = $false; finished_at = [DateTime]::Now.ToString("s") }
WriteNext "Pipeline complete. See VALIDATION_REPORT.md, results\summary\, results\figures\, results\final_report.md."
WLog "=== MASTER ORCHESTRATOR DONE pid=$PID ==="
exit 0
