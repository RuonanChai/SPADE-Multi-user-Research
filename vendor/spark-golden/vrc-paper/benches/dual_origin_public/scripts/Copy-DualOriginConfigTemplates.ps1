<#
.SYNOPSIS
  Copy *.example.json to working config files if missing (first-time setup).
#>
$ErrorActionPreference = "Stop"
$cfg = Join-Path $PSScriptRoot "..\config"
$examples = @(
    @{ Name = "origin_profiles.json"; Example = "origin_profiles.example.json" },
    @{ Name = "distributed_lab.json"; Example = "distributed_lab.example.json" }
)
foreach ($x in $examples) {
    $dst = Join-Path $cfg $x.Name
    $src = Join-Path $cfg $x.Example
    if (-not (Test-Path $dst)) {
        Copy-Item $src $dst
        Write-Host "Created $dst from $($x.Example) — edit before production runs."
    }
    else {
        Write-Host "Skip (exists): $dst"
    }
}
