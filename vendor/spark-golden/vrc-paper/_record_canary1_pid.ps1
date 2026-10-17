$ProcId = 45712
$PidFile = "D:\Program\spark-main\spark-main\vrc-paper\results_260512\CANARY1_PID.txt"
Set-Content -Path $PidFile -Value $ProcId
$alive = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if ($alive) {
    Write-Host "ALIVE pid=$($alive.Id) name=$($alive.ProcessName) cpu=$($alive.CPU) ws=$($alive.WorkingSet64)"
} else {
    Write-Host "NOT_ALIVE pid=$ProcId"
}
