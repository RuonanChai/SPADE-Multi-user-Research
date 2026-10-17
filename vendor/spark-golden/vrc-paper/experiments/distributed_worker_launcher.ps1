# Launches the Worker2 browser shard over SSH using the same env contract as run_experiment_distributed.mjs.
# Prefer calling hybrid_retest.ps1 / run_experiment_distributed.mjs; this script is optional for manual ops.
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = "Stop"
$labPath = Join-Path $RepoRoot "experiments\distributed_lab.json"
if (-not (Test-Path $labPath)) { throw "Missing $labPath" }
$lab = Get-Content -Raw $labPath | ConvertFrom-Json
$login = "$($lab.ssh_user)@$($lab.ssh_host)"
$port = if ($lab.ssh_port) { $lab.ssh_port } else { 22 }
$key = if ($lab.ssh_key_path) { @("-i", $lab.ssh_key_path) } else { @() }
Write-Host "SSH $login — set VRC_* on worker then run node experiments\run_experiment.mjs (see run_experiment_distributed.mjs)." -ForegroundColor Yellow
& ssh @("-o", "BatchMode=yes", "-p", "$port") @key $login "cd /d `"$($lab.remote_repo_path)`" && echo Set env from controller && exit 0"
