# stop_vrc_experiment.ps1
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $ScriptDir "RUNNER_PID.txt"
if (Test-Path $pidFile) {
    $rpid = [int](Get-Content $pidFile -First 1)
    try { Stop-Process -Id $rpid -Force -ErrorAction Stop; Write-Host "Killed runner PID $rpid" }
    catch { Write-Host "Runner PID $rpid not running" }
}
Get-Process | Where-Object { $_.ProcessName -in @('chrome','node') } | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
}
Write-Host "All chrome/node killed."
