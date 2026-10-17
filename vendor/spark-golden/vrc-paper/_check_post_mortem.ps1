$ResultsRoot = "D:\Program\spark-main\spark-main\vrc-paper\results_260512"

Write-Host "=== MASTER PID 46032 ==="
$p = Get-Process -Id 46032 -ErrorAction SilentlyContinue
if ($p) { Write-Host "ALIVE cpu=$($p.CPU)" } else { Write-Host "EXITED" }

Write-Host ""
Write-Host "=== STRAY VRC PROCS ==="
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "node.exe|chrome.exe|chromium.exe") -and
    ($_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment|sync_server")
} | Select-Object ProcessId, Name | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "=== MASTER STDOUT (last 80) ==="
Get-Content "D:\Program\spark-main\spark-main\vrc-paper\runner_logs\master_20260512_010955.out.log" -Tail 80 -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== RUN_STATE ==="
$rs = "$ResultsRoot\RUN_STATE.json"
if (Test-Path $rs) { Get-Content $rs } else { Write-Host "missing: $rs" }

Write-Host ""
Write-Host "=== RUN_STATUS ==="
$rst = "$ResultsRoot\RUN_STATUS.md"
if (Test-Path $rst) { Get-Content $rst } else { Write-Host "missing: $rst" }

Write-Host ""
Write-Host "=== CANARY1 STATUS.JSONS ==="
Get-ChildItem "$ResultsRoot\raw" -Recurse -Filter status.json -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "--- $($_.FullName) ---"
    $j = Get-Content $_.FullName | ConvertFrom-Json
    Write-Host "status=$($j.status) visual=$($j.visual_status) missing=$($j.missing_users -join ',') crashed=$($j.crashed_users -join ',')"
    foreach ($cr in $j.capture_records) {
        Write-Host ("  {0} strategy={1} valid={2} reason={3}" -f $cr.user_id, $cr.strategy, $cr.screenshot_valid, $cr.failure_reason)
    }
}

Write-Host ""
Write-Host "=== CANARY1 LOG FILES ==="
Get-ChildItem "$ResultsRoot\runner_logs" -Filter "canary1_*" -ErrorAction SilentlyContinue | Select-Object Name,Length | Format-Table -AutoSize | Out-String | Write-Host
