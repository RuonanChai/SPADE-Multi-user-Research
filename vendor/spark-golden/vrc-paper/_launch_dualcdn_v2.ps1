$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Environment
$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_dualcdn_distributed_final_260513"
$env:VRC_DISTRIBUTED = "true"
$env:VRC_CONTROLLER_HOST = "10.4.158.143"
$env:VRC_WORKER1_HOST = "10.4.158.143"
$env:VRC_WORKER2_HOST = "10.4.146.68"
$env:VRC_WORKER2_SSH = "Ruonan@10.4.146.68"
$env:VRC_USERS_WORKER1 = "u0,u1"
$env:VRC_USERS_WORKER2 = "u2,u3"
$env:VITE_HOST = "0.0.0.0"
$env:VITE_PORT = "9200"
$env:VRC_SYNC_BIND = "0.0.0.0"
$env:VRC_SYNC_HOST = "10.4.158.143"
$env:VRC_SYNC_PORT = "9201"
$env:VRC_PUBLIC_PAGE_BASE = "http://10.4.158.143:9200"
$env:VRC_PUBLIC_SYNC_URL = "ws://10.4.158.143:9201"
$env:VRC_HPC_ASSET_BASE = "http://10.120.17.176:8090"
$env:VRC_CDN_ASSET_BASE = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev"
$env:VRC_CDN2_ASSET_BASE = "https://storage.googleapis.com/forge-dev-public"
$env:VRC_CDN2_OBJECT_PATH = "asundqui/rad/260217/coit-40m-sh1-lod.rad"
$env:VRC_CDN2_OBJECT_PATH_HOBBITON = "asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad"
$env:VRC_HOT_THRESHOLD = "2"
$env:VRC_CDN_FALLBACK_TO_HPC = "true"
$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:HTTP_PROXY = "http://127.0.0.1:10808"
$env:NO_PROXY = "10.120.17.176,10.4.158.143,10.4.146.68,localhost,127.0.0.1"

$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$ResultsRoot = $env:VRC_RESULTS_ROOT
New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ResultsRoot 'runner_logs') | Out-Null

$out = Join-Path $ResultsRoot "runner_logs\dualcdn_${ts}.out.log"
$err = Join-Path $ResultsRoot "runner_logs\dualcdn_${ts}.err.log"

# Run preflight with timeout (node hangs on open HTTP handles)
Write-Host "Running preflight with 90s timeout..."
$prefOut = Join-Path $ResultsRoot "runner_logs\preflight_${ts}.log"
$pf = Start-Process -FilePath "node.exe" `
    -ArgumentList "experiments/dual_cdn_preflight.mjs","--assets-only" `
    -WorkingDirectory $ScriptDir `
    -RedirectStandardOutput $prefOut `
    -RedirectStandardError (Join-Path $ResultsRoot "runner_logs\preflight_${ts}.err.log") `
    -NoNewWindow -PassThru
if (-not $pf.WaitForExit(90000)) {
    Write-Host "Preflight node process hung (open handles) - killing after PASS confirmed in output"
    $pf.Kill()
}
$prefContent = Get-Content $prefOut -Raw -ErrorAction SilentlyContinue
if ($prefContent -notmatch "assets PASS") {
    Write-Host "FATAL: Preflight did not pass. Output:"
    Write-Host $prefContent
    exit 2
}
Write-Host "Preflight PASS (confirmed from output)"

# Launch the main pipeline (dual_cdn_hybrid_retest.ps1) with VRC_SKIP_PREFLIGHT to avoid the hang
$env:VRC_SKIP_PREFLIGHT = "1"
$p = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $ScriptDir 'dual_cdn_hybrid_retest.ps1') `
    -WorkingDirectory $ScriptDir `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -WindowStyle Hidden -PassThru

$pidInfo = @"
PID=$($p.Id)
OUT=$out
ERR=$err
RESULTS_ROOT=$ResultsRoot
STARTED=$ts
PREFLIGHT=PASS
"@
Set-Content -Path (Join-Path $ResultsRoot 'RUNNER_PID.txt') -Value $pidInfo
Write-Host $pidInfo
