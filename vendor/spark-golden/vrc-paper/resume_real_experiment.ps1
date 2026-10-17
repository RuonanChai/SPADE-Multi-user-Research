# resume_real_experiment.ps1
# Detect missing runs in results/raw and rerun only those.
param(
    [string]$Methods   = "Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC",
    [string]$Scenarios = "nearby,burst_turn,divergent",
    [int]   $Trials    = 3
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ResultsRoot = if ($env:VRC_RESULTS_ROOT -and $env:VRC_RESULTS_ROOT.Trim()) {
  $env:VRC_RESULTS_ROOT.Trim()
} else {
  Join-Path $ScriptDir "results"
}
$rawDir = Join-Path $ResultsRoot "raw"
$env:VRC_RESULTS_ROOT = $ResultsRoot
$existing = @{}
Get-ChildItem $rawDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -match '^([A-Za-z\-]+)_([a-z_]+)_t(\d+)_\d+$') {
        $key = "$($matches[1])|$($matches[2])|$($matches[3])"
        $existing[$key] = $true
    }
}

$missing = @()
foreach ($m in $Methods -split ",") {
    foreach ($s in $Scenarios -split ",") {
        for ($t=0; $t -lt $Trials; $t++) {
            $key = "$m|$s|$t"
            if (-not $existing.ContainsKey($key)) { $missing += @{Method=$m; Scenario=$s; Trial=$t} }
        }
    }
}
Write-Host "Missing runs: $($missing.Count)"
$missing | ForEach-Object { Write-Host "  $($_.Method) $($_.Scenario) t$($_.Trial)" }

if ($missing.Count -eq 0) { Write-Host "All runs already present."; exit 0 }

$env:VRC_METHODS    = ($missing | ForEach-Object { $_.Method }   | Sort-Object -Unique) -join ","
$env:VRC_SCENARIOS  = ($missing | ForEach-Object { $_.Scenario } | Sort-Object -Unique) -join ","
$env:VRC_TRIALS     = $Trials
Write-Host "Re-launching detached with reduced matrix: methods=$($env:VRC_METHODS) scenarios=$($env:VRC_SCENARIOS)"
& (Join-Path $ScriptDir "run_real_experiment_detached.ps1") -Phase full
