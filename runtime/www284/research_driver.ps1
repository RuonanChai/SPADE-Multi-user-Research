# WWW284 research driver. One tick per invocation. Does not own the physical executor.
$ErrorActionPreference = "Stop"
$Root = "F:\WWW_N3_MUX"
$Rc = Join-Path $Root "research_control"
$Log = Join-Path $Rc "driver.log"
New-Item -ItemType Directory -Force -Path $Rc | Out-Null
function Write-Log($Message) {
  $line = "{0} {1}`n" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $Message
  [System.IO.File]::AppendAllText($Log, $line, [System.Text.UTF8Encoding]::new($false))
}
if (Test-Path (Join-Path $Rc "PAUSE.flag")) {
  Write-Log "PAUSE flag set; tick will not launch a cell"
}
$python = "D:\Download\MinGW-W64\ucrt64\bin\python.exe"
if (-not (Test-Path (Join-Path $Root "results\DEVELOPMENT_MASTER.csv"))) {
  Write-Log "materialize metrics"
  & $python (Join-Path $Root "runtime\www284\measure_existing.py") | ForEach-Object { Write-Log $_ }
}
& $python (Join-Path $Root "runtime\www284\research_tick.py") | ForEach-Object { Write-Log $_ }
Write-Log "ledger tick exit $LASTEXITCODE"
Write-Log "WWW286 current session is the only research agent; driver will not call agent -p"
exit 0
