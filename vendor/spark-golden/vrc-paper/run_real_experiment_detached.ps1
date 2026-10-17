# run_real_experiment_detached.ps1
# Detached, resumable launcher for VRC real experiment phases.
# Usage: powershell -ExecutionPolicy Bypass -File run_real_experiment_detached.ps1 -Phase canary1|canary2|canary3|full

param(
    [ValidateSet("canary1","canary2","canary3","full")]
    [string]$Phase = "canary1"
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$LogDir    = Join-Path $ScriptDir "runner_logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$logOut = Join-Path $LogDir "${Phase}_${ts}.out.log"
$logErr = Join-Path $LogDir "${Phase}_${ts}.err.log"
$pidFile = Join-Path $ScriptDir "RUNNER_PID.txt"

switch ($Phase) {
    "canary1" {
        $env:VRC_METHODS    = "Full"
        $env:VRC_SCENARIOS  = "nearby"
        $env:VRC_TRIALS     = "1"
    }
    "canary2" {
        $env:VRC_METHODS    = "Full,Spark-MU,VRC"
        $env:VRC_SCENARIOS  = "nearby"
        $env:VRC_TRIALS     = "1"
    }
    "canary3" {
        $env:VRC_METHODS    = "VRC"
        $env:VRC_SCENARIOS  = "nearby,burst_turn,divergent"
        $env:VRC_TRIALS     = "1"
    }
    "full" {
        $env:VRC_METHODS    = "Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC"
        $env:VRC_SCENARIOS  = "nearby,burst_turn,divergent"
        $env:VRC_TRIALS     = "3"
    }
}

$env:VRC_TRIAL_DURATION_MS = "30000"
$env:VRC_HEADLESS          = "true"
$env:VRC_SMOKE             = "0"
$env:VITE_PORT             = "9200"
$env:VRC_SYNC_PORT         = "9201"
$env:VRC_PHASE             = $Phase

# Locate node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    $node = "C:\Program Files\nodejs\node.exe"
}
if (-not (Test-Path $node)) {
    Write-Host "FATAL: node.exe not found"
    exit 1
}

$runnerScript = Join-Path $ScriptDir "experiments\run_experiment.mjs"

Write-Host "[detached] Phase=$Phase"
Write-Host "[detached] Methods=$($env:VRC_METHODS) Scenarios=$($env:VRC_SCENARIOS) Trials=$($env:VRC_TRIALS)"
Write-Host "[detached] stdout: $logOut"
Write-Host "[detached] stderr: $logErr"

$proc = Start-Process -FilePath $node -ArgumentList "`"$runnerScript`"","--full" `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError  $logErr `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $pidFile -Value "$($proc.Id)`n$Phase`n$logOut`n$logErr"
Write-Host "[detached] PID $($proc.Id) launched. Logs: $logOut"
