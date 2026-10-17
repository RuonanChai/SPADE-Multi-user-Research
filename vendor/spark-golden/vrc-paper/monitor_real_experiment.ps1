# monitor_real_experiment.ps1
param([int]$TailLines = 50)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $ScriptDir "RUNNER_PID.txt"

if (-not (Test-Path $pidFile)) {
    Write-Host "No RUNNER_PID.txt — no detached runner has been launched yet."
    exit 0
}

$lines = Get-Content $pidFile
$rpid = [int]$lines[0]
$phase = $lines[1]
$logOut = $lines[2]
$logErr = $lines[3]

$alive = Get-Process -Id $rpid -ErrorAction SilentlyContinue
Write-Host "PID=$rpid Phase=$phase  Alive=$($alive -ne $null)"

$resultsRaw = Join-Path $ScriptDir "results\raw"
$runs = (Get-ChildItem $resultsRaw -Directory -ErrorAction SilentlyContinue).Count
$pngs = (Get-ChildItem (Join-Path $ScriptDir "results\screenshots") -Filter "*.png" -ErrorAction SilentlyContinue).Count
Write-Host "Run dirs so far: $runs   Screenshots: $pngs"

Write-Host "`n--- stdout tail ---"
if (Test-Path $logOut) { Get-Content $logOut -Tail $TailLines }
Write-Host "`n--- stderr tail ---"
if (Test-Path $logErr) { Get-Content $logErr -Tail 20 }
