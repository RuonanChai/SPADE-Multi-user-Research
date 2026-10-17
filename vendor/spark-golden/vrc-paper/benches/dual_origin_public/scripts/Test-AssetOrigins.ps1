<#
.SYNOPSIS
  HTTP probe for Coit flat key on each HTTP(S) base in origin_profiles.json (skips VRC_USE_GCS_ONLY=1 profiles).
#>
param(
    [string]$ProfilesPath = ""
)

$ErrorActionPreference = "Continue"
$ScriptDir = $PSScriptRoot
$BenchRoot = Join-Path $ScriptDir ".."
if ([string]::IsNullOrWhiteSpace($ProfilesPath)) {
    $ProfilesPath = Join-Path $BenchRoot "config\origin_profiles.json"
}
if (-not (Test-Path $ProfilesPath)) {
    Write-Error "Missing $ProfilesPath"
    exit 2
}

$doc = Get-Content $ProfilesPath -Raw -Encoding UTF8 | ConvertFrom-Json
$key = "streaming-lod/coit-40m-sh1-lod.rad"

foreach ($prof in $doc.profiles) {
    $id = [string]$prof.id
    $gcs = $prof.env.VRC_USE_GCS_ONLY
    if ([string]$gcs -eq "1") {
        Write-Host "[$id] skip probe (GCS-only profile — use browser or gcs URL manually)"
        continue
    }
    $base = [string]$prof.env.VRC_RAD_ASSET_BASE
    if ([string]::IsNullOrWhiteSpace($base)) {
        Write-Host "[$id] skip (no VRC_RAD_ASSET_BASE)"
        continue
    }
    $url = "$($base.TrimEnd('/'))/$key"
    Write-Host "[$id] HEAD $url"
    try {
        $r = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 25 -UseBasicParsing
        Write-Host "  -> status $($r.StatusCode)"
    }
    catch {
        Write-Host "  -> FAIL: $($_.Exception.Message)"
    }
}
