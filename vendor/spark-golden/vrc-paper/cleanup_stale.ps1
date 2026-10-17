Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'node\.exe|chrome\.exe' -and
  $_.CommandLine -match 'vrc-paper|9200|9201|playwright|vite|run_experiment|sync_server'
} | ForEach-Object {
  Write-Host "Killing PID $($_.ProcessId)"
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "Process cleanup done"
