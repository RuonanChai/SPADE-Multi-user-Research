# vrc_autopilot_loop.ps1
# 外层循环：在同一「会话根目录」下多次启动 run_autonomous_pipeline_detached.ps1，
# 每次使用独立 attempt 子目录，直到成功或超时。
#
# 重要（与 Cursor Skills 的关系）：
#   - Skill 文件不会自己运行；它们只在「被 Agent 读到」时起指导作用。
#   - 本脚本可以 7x24 重复「跑实验」；若失败原因是代码/环境 bug，仅靠重跑通常不会自愈。
#   - 可选 -HookScript：在每次编排 exit 后调用你的脚本（例如内部调用 node + @cursor/sdk
#     的 Agent.prompt，或写出一个待粘贴给 Claude Code 的摘要文件）。
#
# 用法（PowerShell）：
#   从仓库根（spark-main）推荐：
#     powershell -ExecutionPolicy Bypass -File scripts\vrc_paper_experiment.ps1 autopilot -RunFullPipeline
#   或仍从 vrc-paper\scripts：
#     .\vrc_autopilot_loop.ps1 -MaxHours 24 -RunFullPipeline
#     .\vrc_autopilot_loop.ps1 -RepoRoot D:\...\spark-main -MaxHours 24 -RunFullPipeline
#
param(
    [int]$MaxHours = 24,
    [int]$SleepBetweenAttemptsMinutes = 20,
    [switch]$RunFullPipeline,
    [string]$HookScript = "",
    [string]$SessionRoot = "",
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Continue"
if ($RepoRoot) {
    $VrcPaper = Join-Path $RepoRoot "vrc-paper"
    $Orchestrator = Join-Path $VrcPaper "run_autonomous_pipeline_detached.ps1"
    if (-not (Test-Path $Orchestrator)) { throw "Missing: $Orchestrator (check -RepoRoot)" }
    $session = if ($SessionRoot) { $SessionRoot } else { Join-Path $VrcPaper ("results_autopilot_session_" + (Get-Date -Format "yyyyMMdd_HHmmss")) }
} else {
    $VrcPaper = Split-Path -Parent $PSScriptRoot
    $Orchestrator = Join-Path $VrcPaper "run_autonomous_pipeline_detached.ps1"
    if (-not (Test-Path $Orchestrator)) { throw "Missing: $Orchestrator" }
    $session = if ($SessionRoot) { $SessionRoot } else { Join-Path $VrcPaper ("results_autopilot_session_" + (Get-Date -Format "yyyyMMdd_HHmmss")) }
}
New-Item -ItemType Directory -Force -Path $session | Out-Null
$summary = Join-Path $session "AUTOPILOT_SUMMARY.md"
$deadline = (Get-Date).AddHours($MaxHours)
$n = 0

function Append-Summary([string]$line) {
    Add-Content -Path $summary -Value $line
    Write-Host $line
}

Append-Summary "# VRC Autopilot session"
Append-Summary "- Session root: ``$session``"
Append-Summary "- Max wall clock: $MaxHours h"
Append-Summary "- Run full 72 + aggregate: $(if ($RunFullPipeline) { 'yes' } else { 'no (prefull-only unless orchestrator default changes)' })"
Append-Summary "- Started: $([DateTime]::Now.ToString('s'))"
Append-Summary ""

while ((Get-Date) -lt $deadline) {
    $n++
    $attemptDir = Join-Path $session ("attempt_" + ($n.ToString("000")))
    New-Item -ItemType Directory -Force -Path $attemptDir | Out-Null

    $env:VRC_RESULTS_ROOT = $attemptDir
    if ($RunFullPipeline) { $env:VRC_RUN_FULL_PIPELINE = "1" }
    else { Remove-Item env:VRC_RUN_FULL_PIPELINE -ErrorAction SilentlyContinue }

    Append-Summary "## Attempt $n"
    Append-Summary "- VRC_RESULTS_ROOT=$attemptDir"
    Append-Summary "- Launch: $(Get-Date -Format s)"

    & powershell -NoProfile -ExecutionPolicy Bypass -File $Orchestrator
    $code = $LASTEXITCODE

    $log = Join-Path $attemptDir "runner_logs"
    $orchLog = Get-ChildItem $log -Filter "orchestrator_*.out.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1

    Append-Summary "- Orchestrator exit code: $code"

    $statePath = Join-Path $attemptDir "RUN_STATE.json"
    $phase = "unknown"
    if (Test-Path $statePath) {
        try {
            $st = Get-Content $statePath -Raw | ConvertFrom-Json
            $phase = "$($st.phase)"
        } catch { $phase = "parse_error" }
    }
    Append-Summary "- RUN_STATE.phase: $phase"

    if ($orchLog) {
        $tail = Get-Content $orchLog.FullName -Tail 25 -ErrorAction SilentlyContinue
        Append-Summary "- Tail ``$($orchLog.Name)``:"
        foreach ($ln in $tail) { Append-Summary ("  > " + $ln) }
    }

    $success = $false
    if ($code -eq 0) {
        if ($RunFullPipeline) {
            if ($phase -eq "complete") { $success = $true }
        } else {
            if ($phase -eq "prefull_complete" -or $phase -eq "complete") { $success = $true }
        }
    }
    if ($success) {
        Append-Summary ""
        Append-Summary "**SUCCESS** after attempt $n"
        Append-Summary "- Finished: $(Get-Date -Format s)"
        exit 0
    }

    if ($HookScript -and (Test-Path $HookScript)) {
        Append-Summary "- Running hook: $HookScript"
        try {
            $repoForHook = Split-Path $VrcPaper -Parent
            & $HookScript -ResultsRoot $attemptDir -OrchestratorExitCode $code -Attempt $n -RepoRoot $repoForHook
        } catch {
            Append-Summary "- Hook ERROR: $($_.Exception.Message)"
        }
    }

    Append-Summary ""
    $sleepSec = [Math]::Max(60, $SleepBetweenAttemptsMinutes * 60)
    Write-Host "Sleeping $sleepSec s before next attempt..."
    Start-Sleep -Seconds $sleepSec
}

Append-Summary "**TIMEOUT** after $MaxHours h (last attempt $n)"
Append-Summary "- Finished: $(Get-Date -Format s)"
exit 2
