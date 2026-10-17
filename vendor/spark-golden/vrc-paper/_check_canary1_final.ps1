$ResultsRoot = "D:\Program\spark-main\spark-main\vrc-paper\results_260512"

Write-Host "=== PID 45712 ==="
$p = Get-Process -Id 45712 -ErrorAction SilentlyContinue
if ($p) { Write-Host "STILL_ALIVE cpu=$($p.CPU)" } else { Write-Host "EXITED" }

Write-Host ""
Write-Host "=== STRAY VRC PROCS ==="
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "node.exe|chrome.exe|chromium.exe") -and
    ($_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment|sync_server")
} | Select-Object ProcessId, Name | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "=== SCREENSHOTS ==="
Get-ChildItem "$ResultsRoot\screenshots" -File -ErrorAction SilentlyContinue | Select-Object Name,Length | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "=== STATUS.JSON ==="
$statusFiles = Get-ChildItem "$ResultsRoot\raw" -Recurse -Filter status.json -ErrorAction SilentlyContinue
foreach ($f in $statusFiles) {
    Write-Host "--- $($f.FullName) ---"
    Get-Content $f.FullName
}

Write-Host ""
Write-Host "=== VISUAL_CHECK.JSON ==="
$vcFiles = Get-ChildItem "$ResultsRoot\raw" -Recurse -Filter visual_check.json -ErrorAction SilentlyContinue
foreach ($f in $vcFiles) {
    Write-Host "--- $($f.FullName) ---"
    Get-Content $f.FullName
}

Write-Host ""
Write-Host "=== SCREENSHOT_TIMING.JSONL ==="
$stFiles = Get-ChildItem "$ResultsRoot\raw" -Recurse -Filter screenshot_timing.jsonl -ErrorAction SilentlyContinue
foreach ($f in $stFiles) {
    Write-Host "--- $($f.FullName) ---"
    Get-Content $f.FullName
}

Write-Host ""
Write-Host "=== RUN_PASS_FAIL.CSV ==="
$rpf = "$ResultsRoot\summary\run_pass_fail.csv"
if (Test-Path $rpf) { Get-Content $rpf } else { Write-Host "missing: $rpf" }

Write-Host ""
Write-Host "=== STDOUT LAST 40 LINES ==="
$outLog = "$ResultsRoot\runner_logs\canary1_20260511_221811.out.log"
if (Test-Path $outLog) { Get-Content $outLog -Tail 40 } else { Write-Host "missing: $outLog" }
