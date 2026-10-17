$ProcId = 45712
$ResultsRoot = "D:\Program\spark-main\spark-main\vrc-paper\results_260512"
$OutLog = "$ResultsRoot\runner_logs\canary1_20260511_221811.out.log"
$ErrLog = "$ResultsRoot\runner_logs\canary1_20260511_221811.err.log"

Write-Host "=== PROCESS ==="
$p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if ($p) {
    Write-Host "ALIVE pid=$($p.Id) cpu=$($p.CPU) ws_mb=$([math]::Round($p.WorkingSet64/1MB,1))"
} else {
    Write-Host "EXITED pid=$ProcId"
}

Write-Host ""
Write-Host "=== STRAY VRC NODE/VITE/CHROME ==="
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "node.exe|chrome.exe|chromium.exe") -and
    ($_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment|sync_server")
} | Select-Object ProcessId, Name | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "=== STDOUT TAIL (last 80 lines) ==="
if (Test-Path $OutLog) { Get-Content $OutLog -Tail 80 } else { Write-Host "missing: $OutLog" }

Write-Host ""
Write-Host "=== STDERR TAIL (last 20 lines) ==="
if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 20 } else { Write-Host "missing: $ErrLog" }

Write-Host ""
Write-Host "=== SCREENSHOTS ==="
Get-ChildItem -Path "$ResultsRoot\screenshots" -File -ErrorAction SilentlyContinue | Select-Object Name,Length | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "=== RAW RUN CONTENTS ==="
Get-ChildItem -Path "$ResultsRoot\raw" -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "status.json|visual_check.json|screenshot_timing.jsonl" } | ForEach-Object { Write-Host $_.FullName }
