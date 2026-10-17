$p = Get-Process -Id 46032 -ErrorAction SilentlyContinue
if ($p) {
    Write-Host "ALIVE pid=$($p.Id) cpu=$($p.CPU) ws_mb=$([math]::Round($p.WorkingSet64/1MB,1))"
} else {
    Write-Host "EXITED pid=46032"
}
Write-Host ""
Write-Host "=== master stdout tail ==="
$out = "D:\Program\spark-main\spark-main\vrc-paper\runner_logs\master_20260512_010955.out.log"
if (Test-Path $out) { Get-Content $out -Tail 20 } else { Write-Host "missing: $out" }
