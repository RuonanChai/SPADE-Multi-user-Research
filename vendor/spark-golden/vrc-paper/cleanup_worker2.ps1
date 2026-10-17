$ErrorActionPreference = "Continue"
$sshKey = "C:/Users/IoT/.ssh/id_ed25519_spark_bench"
$login = "Ruonan@10.4.146.68"

# Clean partial staging from aborted scp -r
Write-Host "Cleaning Worker2 _push_staging..."
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p 22 -i $sshKey $login "cmd /c rmdir /S /Q D:\SparkRuns\_push_staging 2>NUL & echo CLEAN_OK"

# Kill any stale node/chrome on Worker2 from previous run
Write-Host "Killing stale processes on Worker2..."
$killCmd = 'powershell -NoProfile -Command "Get-Process -Name node,chrome -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match ''run_experiment|playwright|vrc'' } | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Host KILL_OK"'
ssh -o BatchMode=yes -p 22 -i $sshKey $login $killCmd

Write-Host "Worker2 cleanup done"
