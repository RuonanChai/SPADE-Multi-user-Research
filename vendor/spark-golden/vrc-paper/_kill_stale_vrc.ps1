$ErrorActionPreference = "Continue"
$killed = @()
try {
    Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match "node.exe|chrome.exe|chromium.exe") -and
        ($_.CommandLine -match "vrc-paper|9200|9201|playwright|vite|run_experiment|sync_server")
    } | ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $killed += "pid=$($_.ProcessId) name=$($_.Name)"
        } catch {}
    }
} catch {
    Write-Host "cleanup-error: $_"
}
Write-Host "killed-count: $($killed.Count)"
foreach ($k in $killed) { Write-Host $k }
Write-Host "DONE"
