$ErrorActionPreference = "Continue"
Set-Location "D:\Program\spark-main\spark-main\vrc-paper"
$env:VRC_RESULTS_ROOT = "D:\Program\spark-main\spark-main\vrc-paper\results_rerun_20260516_202047"

Write-Host "=== 1. validate_canary.mjs ==="
if (Test-Path "analysis\validate_canary.mjs") {
  node analysis/validate_canary.mjs
  Write-Host "validate_canary exit=$LASTEXITCODE"
} else {
  Write-Host "validate_canary.mjs not found — skip"
}

Write-Host ""
Write-Host "=== 2. Dual-machine IPs in per_client_metrics ==="
$pcm = Join-Path $env:VRC_RESULTS_ROOT "summary\per_client_metrics.csv"
if (Test-Path $pcm) {
  $rows = Import-Csv $pcm
  $ips = $rows | Select-Object -ExpandProperty host_ip -Unique
  Write-Host "Unique host_ip values: $($ips -join ', ')"
  $has143 = $ips -contains "10.4.158.143"
  $has68 = $ips -contains "10.4.146.68"
  Write-Host "Worker1 (10.4.158.143): $has143"
  Write-Host "Worker2 (10.4.146.68): $has68"
  if ($has143 -and $has68) { Write-Host "DUAL-MACHINE: PASS" } else { Write-Host "DUAL-MACHINE: FAIL" }
} else {
  Write-Host "per_client_metrics.csv not found"
}

Write-Host ""
Write-Host "=== 3. CDN2 evidence (H3/H5 sessions) ==="
$rpf = Join-Path $env:VRC_RESULTS_ROOT "summary\run_pass_fail.csv"
$runs = Import-Csv $rpf
# H3 = run 3 (vrc_guided_hybrid cdn2), H3b = run 4 (hybrid mixed dual-CDN)
$h3sid = ($runs | Where-Object { $_.run -eq "3" }).session_id
$h5sid = ($runs | Where-Object { $_.run -eq "6" }).session_id
Write-Host "H3 session: $h3sid"
Write-Host "H5 session: $h5sid"

# Check source_breakdown or request_logs for cdn2 evidence
$sb = Join-Path $env:VRC_RESULTS_ROOT "summary\source_breakdown.csv"
if (Test-Path $sb) {
  Write-Host ""
  Write-Host "=== source_breakdown.csv (last 10 rows) ==="
  Get-Content $sb | Select-Object -Last 10
}

Write-Host ""
Write-Host "=== 4. Session digest gate_ok ==="
$rawDir = Join-Path $env:VRC_RESULTS_ROOT "raw"
$digests = Get-ChildItem -Path $rawDir -Filter "session_digest.json" -Recurse | Select-Object -First 5
foreach ($d in $digests) {
  $j = Get-Content $d.FullName -Raw | ConvertFrom-Json
  Write-Host "$($d.Directory.Name): gate_ok=$($j.gate_ok)"
}
