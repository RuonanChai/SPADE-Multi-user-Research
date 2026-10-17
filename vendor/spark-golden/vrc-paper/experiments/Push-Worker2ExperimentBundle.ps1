#Requires -Version 5.1

<#

  One-shot: scp-push Worker2 Playwright shard manifest only (NOT the whole vrc-paper/ tree).

  Manifest: vrc-paper/experiments/worker2_push_manifest.mjs



  Usage (orchestrator / Worker1, cwd = spark-main):

    powershell -ExecutionPolicy Bypass -File vrc-paper\experiments\Push-Worker2ExperimentBundle.ps1



  Optional:

    -ConfigPath "D:\path\to\distributed_lab.json"



  Run again after editing any manifest file on Worker1.

#>

param(

  [string]$ConfigPath = ""

)



$ErrorActionPreference = "Stop"

$ExperimentsDir = $PSScriptRoot

$SparkMainRoot = Split-Path (Split-Path $ExperimentsDir -Parent) -Parent

$ManifestScript = Join-Path $ExperimentsDir "worker2_push_manifest.mjs"



if (-not $ConfigPath -or -not $ConfigPath.Trim()) {

  $ConfigPath = Join-Path $ExperimentsDir "distributed_lab.json"

}

if (-not (Test-Path $ConfigPath)) {

  throw "Missing config: $ConfigPath"

}

if (-not (Test-Path $ManifestScript)) {

  throw "Missing manifest: $ManifestScript"

}



$lab = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json

$sshUser = [string]$lab.ssh_user

$sshHost = [string]$lab.ssh_host

$port = if ($lab.ssh_port) { [int]$lab.ssh_port } else { 22 }

$key = [string]$lab.ssh_key_path

$remoteBase = ([string]$lab.remote_repo_path).Trim().Replace("\", "/").TrimEnd("/")

$remoteResults = [string]$lab.remote_results_root
if (-not $remoteResults.Trim()) { $remoteResults = "D:/SparkRuns" }
$remoteTmp = $remoteResults.Trim().Replace("\", "/").TrimEnd("/") + "/_push_staging"

if (-not $sshUser -or -not $sshHost -or -not $remoteBase) {

  throw "distributed_lab.json needs ssh_user, ssh_host, remote_repo_path"

}



$login = "${sshUser}@${sshHost}"

$keyArg = @()

if ($key) { $keyArg = @("-i", ($key -replace "\\", "/")) }



$pushRoot = $remoteBase

if ($remoteBase -match " ") { $pushRoot = $remoteTmp }



Push-Location $ExperimentsDir
try {
  $listJson = node -e "import { collectWorker2PushFiles } from './worker2_push_manifest.mjs'; console.log(JSON.stringify(collectWorker2PushFiles(process.argv[1])))" $SparkMainRoot
  if ($LASTEXITCODE -ne 0) { throw "worker2_push_manifest.mjs failed exit=$LASTEXITCODE" }
} finally { Pop-Location }

$files = $listJson | ConvertFrom-Json



Write-Host "=== Worker2 manifest push ($($files.Count) files) -> ${login}:${remoteBase}/ ===" -ForegroundColor Cyan

Write-Host "    (NOT scp -r vrc-paper/)" -ForegroundColor DarkGray



function Ensure-RemoteDir([string]$WinPath) {
  # cmd mkdir creates intermediate dirs; ignore exit 1 if already exists.
  & ssh @("-o", "BatchMode=yes", "-p", "$port") @keyArg $login "cmd /c mkdir `"$WinPath`" 2>nul"
}

if ($remoteBase -match " ") {
  Ensure-RemoteDir ($remoteTmp -replace '/', '\')
}



foreach ($entry in $files) {

  $rel = [string]$entry.rel

  $local = [string]$entry.local

  $remoteFile = "$pushRoot/$rel" -replace "\\", "/"

  $parent = $remoteFile -replace "/[^/]+$", ""

  $parentWin = $parent -replace "/", "\"

  Ensure-RemoteDir $parentWin

  Write-Host "  scp $rel" -ForegroundColor Gray

  & scp @("-o", "BatchMode=yes", "-P", "$port") @keyArg $local "${login}:${remoteFile}"

  if ($LASTEXITCODE -ne 0) { throw "scp $rel failed exit=$LASTEXITCODE" }

}



if ($remoteBase -match " ") {

  $remoteWin = $remoteBase -replace "/", "\"

  $tmpWin = $remoteTmp -replace "/", "\"

  foreach ($entry in $files) {

    $winRel = ([string]$entry.rel) -replace "/", "\"

    $destParent = Split-Path (Join-Path $remoteWin $winRel) -Parent

    Ensure-RemoteDir $destParent

    & ssh @("-o", "BatchMode=yes", "-p", "$port") @keyArg $login "cmd /c copy /Y `"$tmpWin\$winRel`" `"$remoteWin\$winRel`" >NUL"

  }

  & ssh @("-o", "BatchMode=yes", "-p", "$port") @keyArg $login "cmd /c rmdir /S /Q `"$tmpWin`" 2>NUL"

}



Write-Host "Done. Verify: ${remoteBase}/vrc-paper/experiments/run_experiment.mjs" -ForegroundColor Green

