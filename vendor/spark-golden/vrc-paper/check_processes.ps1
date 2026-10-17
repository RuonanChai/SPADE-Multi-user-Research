Write-Host "=== SSH/SCP processes ==="
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'scp|ssh|sftp'
} | ForEach-Object {
  $cmd = if ($_.CommandLine.Length -gt 200) { $_.CommandLine.Substring(0,200) } else { $_.CommandLine }
  Write-Host "PID=$($_.ProcessId) Name=$($_.Name) Cmd=$cmd"
}

Write-Host ""
Write-Host "=== Node experiment processes ==="
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'run_experiment|dual_cdn|hybrid_retest|preflight'
} | ForEach-Object {
  $cmd = if ($_.CommandLine.Length -gt 200) { $_.CommandLine.Substring(0,200) } else { $_.CommandLine }
  Write-Host "PID=$($_.ProcessId) Cmd=$cmd"
}

Write-Host ""
Write-Host "=== PowerShell processes with vrc-paper ==="
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'vrc-paper|phase1|hybrid_retest'
} | ForEach-Object {
  $cmd = if ($_.CommandLine.Length -gt 200) { $_.CommandLine.Substring(0,200) } else { $_.CommandLine }
  Write-Host "PID=$($_.ProcessId) Cmd=$cmd"
}
