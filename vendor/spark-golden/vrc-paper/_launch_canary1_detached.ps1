$ErrorActionPreference = "Continue"
$Root       = "D:\Program\spark-main\spark-main"
$VrcPaper   = Join-Path $Root "vrc-paper"
$ResultsRoot = Join-Path $VrcPaper "results_260512"
$LogDir     = Join-Path $ResultsRoot "runner_logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Ts  = Get-Date -Format "yyyyMMdd_HHmmss"
$Out = Join-Path $LogDir "canary1_${Ts}.out.log"
$Err = Join-Path $LogDir "canary1_${Ts}.err.log"
$PidFile = Join-Path $ResultsRoot "CANARY1_PID.txt"

$env:VRC_METHODS           = "Full"
$env:VRC_SCENARIOS         = "nearby"
$env:VRC_TRIALS            = "1"
$env:VRC_TRIAL_DURATION_MS = "30000"
$env:VRC_HEADLESS          = "true"
$env:VRC_SMOKE             = "0"
$env:VITE_PORT             = "9200"
$env:VRC_SYNC_PORT         = "9201"
$env:VRC_PHASE             = "canary1"
$env:VRC_RESULTS_ROOT      = $ResultsRoot

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $Node)) { Write-Host "FATAL: node not found"; exit 2 }

$Runner = Join-Path $VrcPaper "experiments\run_experiment.mjs"

$proc = Start-Process -FilePath $Node -ArgumentList "`"$Runner`"","--full" `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $Out `
    -RedirectStandardError  $Err `
    -WindowStyle Hidden -PassThru

Set-Content -Path $PidFile -Value $proc.Id
Write-Host "PID: $($proc.Id)"
Write-Host "OUT: $Out"
Write-Host "ERR: $Err"
Write-Host "RESULTS_ROOT: $ResultsRoot"
