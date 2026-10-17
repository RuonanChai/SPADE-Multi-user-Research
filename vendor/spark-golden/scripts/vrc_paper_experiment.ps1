# vrc_paper_experiment.ps1
# 从 spark-main 仓库根发起 vrc-paper 真实实验编排 / 24h autopilot。
# 必须在仓库根执行（或通过 npm run，cwd 已为根）：
#   npm run vrc:paper:check
#   npm run vrc:paper:orchestrator
#   npm run vrc:paper:autopilot:72
#
param(
    [Parameter(Position = 0)]
    [ValidateSet("check", "orchestrator-detached", "autopilot")]
    [string]$Command = "check",
    [switch]$RunFullPipeline,
    [int]$MaxHours = 24,
    [int]$SleepBetweenAttemptsMinutes = 20,
    [string]$HookScript = ""
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$VrcPaper = Join-Path $RepoRoot "vrc-paper"
$Orchestrator = Join-Path $VrcPaper "run_autonomous_pipeline_detached.ps1"
$Autopilot = Join-Path $VrcPaper "scripts\vrc_autopilot_loop.ps1"

function Test-RepoLayout {
    if (-not (Test-Path $VrcPaper)) { throw "Missing vrc-paper under: $RepoRoot" }
    if (-not (Test-Path $Orchestrator)) { throw "Missing: $Orchestrator" }
    if (-not (Test-Path $Autopilot)) { throw "Missing: $Autopilot" }
}

switch ($Command) {
    "check" {
        Write-Host "RepoRoot: $RepoRoot"
        Test-RepoLayout
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $node) { Write-Warning "node not on PATH" } else { Write-Host "node: $node" }
        $py = (Get-Command python -ErrorAction SilentlyContinue).Source
        if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue).Source }
        if (-not $py) { Write-Warning "python/py not on PATH (orchestrator report phase may skip)" } else { Write-Host "python: $py" }
        Write-Host "OK — layout and toolchain look usable."
    }
    "orchestrator-detached" {
        Test-RepoLayout
        $ts = Get-Date -Format "yyyyMMdd_HHmmss"
        $r = Join-Path $VrcPaper "results_onerun_$ts"
        New-Item -ItemType Directory -Force -Path $r | Out-Null
        $tmp = Join-Path $env:TEMP "vrc_orch_detached_$ts.ps1"
        $rj = ConvertTo-Json $r -Compress
        $pipelineLine = if ($RunFullPipeline) { "`$env:VRC_RUN_FULL_PIPELINE = '1'" } else { "Remove-Item Env:\VRC_RUN_FULL_PIPELINE -ErrorAction SilentlyContinue" }
        $lines = @(
            "`$ErrorActionPreference = 'Continue'",
            "`$env:VRC_RESULTS_ROOT = $rj",
            $pipelineLine,
            ('& ' + (ConvertTo-Json $Orchestrator))
        )
        $lines | Set-Content -Path $tmp -Encoding UTF8
        Start-Process powershell -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $tmp
        ) -WorkingDirectory $VrcPaper
        Write-Host "Detached orchestrator started."
        Write-Host "VRC_RESULTS_ROOT=$r"
        Write-Host "Launcher temp: $tmp"
        Write-Host "Watch: $r\RUN_STATUS.md  and  $r\runner_logs\orchestrator_*.out.log"
    }
    "autopilot" {
        Test-RepoLayout
        $hook = $HookScript
        if (-not $hook -and $env:VRC_AUTOPILOT_HOOK) { $hook = $env:VRC_AUTOPILOT_HOOK }
        $args = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Autopilot,
            "-RepoRoot", $RepoRoot,
            "-MaxHours", "$MaxHours",
            "-SleepBetweenAttemptsMinutes", "$SleepBetweenAttemptsMinutes"
        )
        if ($RunFullPipeline) { $args += "-RunFullPipeline" }
        if ($hook) { $args += "-HookScript", $hook }
        & powershell @args
        exit $LASTEXITCODE
    }
}
