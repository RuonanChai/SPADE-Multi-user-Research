<#
.SYNOPSIS
  Run the existing VRC distributed pipeline once per asset-origin profile (HPC vs R2 vs GCS).
  Reuses vrc-paper/experiments/run_experiment_distributed.mjs — metrics and baselines unchanged.

.DESCRIPTION
  Pipeline (unchanged from upstream):
  - Worker1: Vite + sync + Playwright u0,u1; browsers load vrc_scene from http://<controller>:9200
  - Worker2: SSH shard u2,u3; same page origin; each browser fetches .rad ranges from the URL chosen by profile (VRC_RAD_ASSET_BASE or VRC_USE_GCS_ONLY=1)
  Each profile writes results under: <ResultsRootBase>/<timestamp>_<profileId>/

.PARAMETER RepoRoot
  spark-main repo root (directory that contains vrc-paper/). Auto-detected from this script path if omitted.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [Parameter(Mandatory = $true)][string]$ResultsRootBase,
    [string]$ProfilesPath = "",
    [string]$DistributedLabPath = "",
    [string]$Methods = "Full",
    [string]$Scenarios = "nearby",
    [int]$Trials = 1,
    [string[]]$OnlyProfileIds = @(),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Resolve-SparkMainRoot {
    param([string]$ScriptDir)
    # Script: .../vrc-paper/benches/dual_origin_public/scripts  -> 4 levels up = spark-main
    $p = Resolve-Path (Join-Path $ScriptDir "..\..\..\..")
    if (-not (Test-Path (Join-Path $p "vrc-paper\experiments\run_experiment_distributed.mjs"))) {
        throw "RepoRoot not found from script location. Pass -RepoRoot explicitly (folder containing vrc-paper/)."
    }
    return $p.Path
}

$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Resolve-SparkMainRoot -ScriptDir $ScriptDir
}
$VrcPaper = Join-Path $RepoRoot "vrc-paper"
$BenchRoot = Join-Path $VrcPaper "benches\dual_origin_public"
if ([string]::IsNullOrWhiteSpace($ProfilesPath)) {
    $ProfilesPath = Join-Path $BenchRoot "config\origin_profiles.json"
}
if ([string]::IsNullOrWhiteSpace($DistributedLabPath)) {
    $DistributedLabPath = Join-Path $BenchRoot "config\distributed_lab.json"
}

if (-not (Test-Path $ProfilesPath)) {
    throw "Missing profiles file: $ProfilesPath. Copy config\origin_profiles.example.json to config\origin_profiles.json and edit."
}
if (-not $DryRun -and -not (Test-Path $DistributedLabPath)) {
    throw "Missing distributed lab: $DistributedLabPath. Copy config\distributed_lab.example.json to config\distributed_lab.json and edit, or run scripts\Copy-DualOriginConfigTemplates.ps1"
}

$raw = Get-Content $ProfilesPath -Raw -Encoding UTF8
$doc = $raw | ConvertFrom-Json
if (-not $doc.profiles) { throw "origin_profiles.json must contain a 'profiles' array." }

New-Item -ItemType Directory -Path $ResultsRootBase -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$masterLog = Join-Path $ResultsRootBase "dual_origin_orchestrator_$stamp.log"

function WLog([string]$m) {
    $line = "[$([DateTime]::UtcNow.ToString('s'))Z] $m"
    Write-Host $line
    Add-Content -Path $masterLog -Value $line -Encoding UTF8
}

WLog "RepoRoot=$RepoRoot"
WLog "ResultsRootBase=$ResultsRootBase"
WLog "ProfilesPath=$ProfilesPath"
WLog "DistributedLabPath=$DistributedLabPath"

foreach ($prof in $doc.profiles) {
    $profileId = [string]$prof.id
    if ($OnlyProfileIds.Count -gt 0 -and ($OnlyProfileIds -notcontains $profileId)) { continue }

    $batchDir = Join-Path $ResultsRootBase "${stamp}_$profileId"
    $manifestPath = Join-Path $batchDir "ORIGIN_BATCH_MANIFEST.json"

    WLog "--- Profile $profileId -> $batchDir ---"

    if ($DryRun) {
        WLog "[dry-run] would run distributed with env from profile + VRC_RESULTS_ROOT=$batchDir"
        continue
    }

    if (-not (Test-Path $DistributedLabPath)) {
        throw "Missing distributed lab: $DistributedLabPath"
    }

    New-Item -ItemType Directory -Path $batchDir -Force | Out-Null

    # Clear inherited knobs from previous profile
    foreach ($k in @(
            "VRC_RAD_ASSET_BASE", "VRC_USE_GCS_ONLY", "VRC_METHODS", "VRC_SCENARIOS", "VRC_TRIALS",
            "VRC_RESULTS_ROOT", "VRC_DISTRIBUTED_CONFIG", "VRC_USE_DISTRIBUTED"
        )) {
        Remove-Item "Env:\$k" -ErrorAction SilentlyContinue
    }

    $env:VRC_RESULTS_ROOT = $batchDir
    $env:VRC_DISTRIBUTED_CONFIG = $DistributedLabPath
    $env:VRC_USE_DISTRIBUTED = "1"
    $env:VRC_METHODS = $Methods
    $env:VRC_SCENARIOS = $Scenarios
    $env:VRC_TRIALS = "$Trials"

    if ($prof.env) {
        foreach ($prop in $prof.env.PSObject.Properties) {
            $name = $prop.Name
            $val = [string]$prop.Value
            if ([string]::IsNullOrWhiteSpace($val)) {
                Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
            }
            else {
                Set-Item -Path "Env:\$name" -Value $val
            }
        }
    }

    # Orchestrator requires explicit classification env (SSH whitelist); derive from bench profile when unset.
    if ([string]::IsNullOrWhiteSpace($env:VRC_DELIVERY_PROFILE)) {
        if ($env:VRC_USE_GCS_ONLY -eq "1") {
            $env:VRC_DELIVERY_PROFILE = "static_cdn"
        } else {
            $env:VRC_DELIVERY_PROFILE = "origin_only"
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:VRC_CDN_LABEL)) {
        if ($env:VRC_DELIVERY_PROFILE -eq "origin_only") {
            $env:VRC_CDN_LABEL = "hpc"
        } else {
            $env:VRC_CDN_LABEL = "cdn1"
        }
    }

    $manifest = [ordered]@{
        profile_id          = $profileId
        profile_description = $prof.description
        results_root        = $batchDir
        distributed_lab     = $DistributedLabPath
        methods             = $Methods
        scenarios           = $Scenarios
        trials              = $Trials
        env_snapshot        = @{
            VRC_RAD_ASSET_BASE     = $env:VRC_RAD_ASSET_BASE
            VRC_USE_GCS_ONLY       = $env:VRC_USE_GCS_ONLY
            VRC_DISTRIBUTED_CONFIG = $env:VRC_DISTRIBUTED_CONFIG
            VRC_USE_DISTRIBUTED    = $env:VRC_USE_DISTRIBUTED
        }
        started_utc         = [DateTime]::UtcNow.ToString("s")
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8

    Push-Location $RepoRoot
    try {
        $node = Get-Command node -ErrorAction Stop
        & $node.Path "vrc-paper\experiments\run_experiment_distributed.mjs" 2>&1 | Tee-Object -FilePath (Join-Path $batchDir "distributed_console.log")
        $nodeExit = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    $manifestDone = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifestObj = [ordered]@{}
    foreach ($p in $manifestDone.PSObject.Properties) { $manifestObj[$p.Name] = $p.Value }
    $manifestObj["finished_utc"] = [DateTime]::UtcNow.ToString("s")
    $manifestObj["node_exit_code"] = $nodeExit
    [pscustomobject]$manifestObj | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8

    WLog "Profile $profileId finished exit=$nodeExit"
    if ($nodeExit -ne 0) {
        WLog "WARNING: non-zero exit for profile $profileId — inspect $batchDir"
    }
}

WLog "All requested profiles complete. Master log: $masterLog"
