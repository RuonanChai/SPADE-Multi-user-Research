#Requires -Version 5
<#
debug_visual_single_user.ps1

Run ONE Playwright client against the VRC Spark scene (Coit Tower, Full/nearby/t0)
and capture deep diagnostics for root-causing a blank/black/white screenshot.

Usage:
  # Headful (default — proves GPU works):
  powershell -ExecutionPolicy Bypass -File debug_visual_single_user.ps1
  # Headless:
  powershell -ExecutionPolicy Bypass -File debug_visual_single_user.ps1 -Headless
  # Custom vite/sync ports:
  powershell -ExecutionPolicy Bypass -File debug_visual_single_user.ps1 -VitePort 9200 -SyncPort 9201
#>
param(
  [switch]$Headless,
  [int]$VitePort  = 9200,
  [int]$SyncPort  = 9201,
  [string]$Method = "Full",
  [string]$Scenario = "nearby",
  [int]$HoldMs   = 25000,
  [int]$FirstShotDelayMs = 8000
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
$RepoRoot  = Split-Path -Parent $ScriptDir

$ts     = Get-Date -Format 'yyyyMMdd_HHmmss'
$runId  = "debug_single_${Method}_${Scenario}_t0_${ts}"
$outDir = Join-Path $ScriptDir "results_debug_single\$runId"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$headlessStr = if ($Headless) { "true" } else { "false" }
$envFlags = @{
  VRC_HEADLESS = $headlessStr
  VITE_PORT    = "$VitePort"
  VRC_SYNC_PORT= "$SyncPort"
  VRC_DEBUG_OUT_DIR = (Resolve-Path $outDir).Path
  VRC_DEBUG_METHOD  = $Method
  VRC_DEBUG_SCENARIO= $Scenario
  VRC_DEBUG_HOLD_MS = "$HoldMs"
  VRC_DEBUG_FIRST_SHOT_DELAY_MS = "$FirstShotDelayMs"
}
foreach ($k in $envFlags.Keys) { Set-Item -Path "Env:$k" -Value $envFlags[$k] }

# --- make sure vite is up on $VitePort (don't auto-start sync server; optional) ---
function Test-Port($port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1",$port); $c.Close(); $true
  } catch { $false }
}

if (-not (Test-Port $VitePort)) {
  Write-Host "[debug] vite not running on $VitePort — starting..."
  $viteLog = Join-Path $outDir "vite.log"
  $p = Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoProfile","-ExecutionPolicy","Bypass","-Command",
    "Set-Location '$RepoRoot'; npx vite --port $VitePort --host 0.0.0.0 *>&1 | Tee-Object -FilePath '$viteLog'"
  ) -WindowStyle Hidden -PassThru
  # wait up to 60s
  for ($i=0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Port $VitePort) { break }
  }
  if (-not (Test-Port $VitePort)) {
    Write-Host "[debug] FATAL: vite did not start on $VitePort"; exit 2
  }
  Write-Host "[debug] vite started pid=$($p.Id)"
} else {
  Write-Host "[debug] vite already on $VitePort"
}

# --- run the JS debug driver ---
$driver = Join-Path $ScriptDir "experiments\debug_single_user_driver.mjs"
Write-Host "[debug] running driver: $driver"
Write-Host "[debug] output dir: $outDir"
node --experimental-vm-modules "$driver"
$code = $LASTEXITCODE
Write-Host "[debug] driver exit=$code"
Write-Host "[debug] artifacts in: $outDir"
exit $code
